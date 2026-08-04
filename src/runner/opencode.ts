import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { config } from '../config.js';

import { AsyncQueue } from './queue.js';
import { resolveExecutor, buildSpawn } from './discovery.js';
import { denyNotice } from './boundary.js';
import type {
  BrainAccount,
  LaunchSpec,
  ModelTier,
  Runner,
  RunnerCapability,
  RunnerEvent,
  RunnerSession,
  UsageEvent,
} from './types.js';

/**
 * OpenCode CLI runner.
 *
 * The reason this exists: it is a *free* runner with a competent model behind
 * it. Simba's only other free brain is local Ollama, which manages ~16 tok/s on
 * a 14b quant and follows instructions poorly enough that it cannot be trusted
 * with real work. OpenCode's free tier reports `cost: 0` on every step — that is
 * measured from its own accounting, not assumed — so tier-2 workers, background
 * research and bulk jobs can run continuously without touching subscription
 * headroom. Given that the whole system is built around two $20 plans, a capable
 * brain that costs nothing is worth a proper adapter rather than a shortcut.
 *
 * Mechanically it is closest to Codex:
 *
 *   - `opencode run` is **one-shot**. The turn runs, the process exits.
 *     Continuing means `run -s <sessionID>` in a fresh process, so there is no
 *     streaming stdin and therefore no mid-turn steering — messages queue.
 *   - It **can fork** (`--fork`), which neither Claude Code nor Codex offers.
 *     Advertised as a capability so callers can branch instead of copying.
 *   - Tool activity arrives as a single `tool_use` event carrying both the input
 *     and the output, like Codex's completed items, so both halves of the pair
 *     are emitted together to keep `tool_calls` shaped the same across tools.
 *   - Like Codex there is no structured rate-limit event; free capacity simply
 *     fails. Detection is reactive, which is why checkpoints are per-turn.
 *
 * Two Windows-specific traps, both already paid for elsewhere in this codebase:
 * opencode blocks on stdin when no terminal is attached, so stdin is closed
 * immediately; and the message is a positional argument rather than stdin, so a
 * hydration brief — tens of kilobytes — would run into the ~32k command-line
 * limit. The brief is written to a file and attached with `-f` instead, which is
 * what that flag is for.
 */

const CAPABILITIES: ReadonlySet<RunnerCapability> = new Set<RunnerCapability>([
  'stream',
  'resume',
  'fork',
]);

/**
 * Probed rather than guessed. `minimax-m2.5-free` and `gpt-5-nano` return server
 * errors, and the `github-copilot/*` entries authenticate but report "not
 * licensed to use Copilot". This one answers reliably.
 */
const DEFAULT_MODEL = process.env.SIMBA_OPENCODE_MODEL ?? 'opencode/big-pickle';

function resolveModel(brain: BrainAccount, tier: ModelTier): string {
  return brain.tierModels[tier] ?? DEFAULT_MODEL;
}

/**
 * The commands the profile's regexes are built around, as plain names.
 *
 * Present because an external audit caught a comment in this file claiming the
 * deny list was "enforced by the profile" — untrue, since only the Ollama
 * runner ever read denyPatterns. Failing over from Claude to OpenCode dropped
 * the only hard safety boundary in the system.
 */
const DESTRUCTIVE_COMMANDS = [
  // Disk
  'diskpart', 'format', 'fsutil', 'mountvol',
  'Clear-Disk', 'Initialize-Disk', 'Remove-Partition', 'Set-Partition', 'Format-Volume',
  // Boot
  'bcdedit', 'bcdboot', 'bootrec', 'bootsect',
  // Backups and shadow copies — deleting these is what makes other damage final
  'vssadmin', 'wbadmin',
  // Services
  'sc delete', 'Remove-Service',
];

/**
 * The destructive-command boundary, expressed the way OpenCode matches.
 *
 * Derived by hand rather than translated from the regexes in
 * `permission_profiles.deny_patterns`, after an attempt at auto-translation
 * failed in both directions. Simba stores case-insensitive regexes; OpenCode
 * matches bash commands against globs, and mechanically stripping regex syntax
 * produced `*bdiskpart*` — the `\b` word-boundary escape leaving a stray `b`
 * glued to every token, so nothing matched — alongside `*.exe*` and `*delete*`,
 * which between them would have blocked most commands on Windows. A lossy
 * translation that silently fails open is worse than no translation.
 *
 * The list is small and stable, so it is written out. It covers the same ground
 * the profile does — disk, boot, backup, services — and registry writes are
 * handled separately below because they need two tokens to be meaningful:
 * `reg` alone is harmless, `reg delete HKLM` is not.
 *
 * MEASURED LIMITATION — read before trusting this.
 *
 * OpenCode does not consult `permission.bash` in non-interactive `run` mode.
 * Tested directly, with and without `--auto`: a command matching a `deny` glob
 * executes normally and returns its output. The config is schema-valid and
 * `opencode debug config` shows the rules resolved, so this looks enforced and
 * is not.
 *
 * These rules are therefore written in hope, not in force: they cost nothing,
 * they are correct if OpenCode starts honouring them, and they document the
 * intent. The boundary that actually holds on this runner is the soft one
 * injected into the agent's brief by denyNotice(). Claude enforces the list via
 * a PreToolUse hook and Ollama checks it in its own loop; Codex, Cursor and
 * OpenCode do not enforce it at all.
 */
function denyRulesFor(patterns: string[]): Record<string, 'allow' | 'deny'> {
  const rules: Record<string, 'allow' | 'deny'> = {};

  for (const cmd of DESTRUCTIVE_COMMANDS) {
    // Both bare and as part of a longer line: OpenCode's matcher is a glob over
    // the whole command string, so the wildcards do the work.
    rules[`*${cmd}*`] = 'deny';
  }

  // Registry writes against machine-wide hives. Reads are deliberately allowed —
  // `reg query` is how an agent finds out what is installed.
  for (const verb of ['delete', 'add', 'import']) {
    for (const hive of ['HKLM', 'HKEY_LOCAL_MACHINE', 'HKCR', 'HKEY_CLASSES_ROOT', 'HKU']) {
      rules[`*reg*${verb}*${hive}*`] = 'deny';
    }
  }
  for (const hive of ['HKLM:', 'HKCR:', 'HKU:']) {
    rules[`*Remove-Item*${hive}*`] = 'deny';
    rules[`*Set-ItemProperty*${hive}*`] = 'deny';
    rules[`*New-ItemProperty*${hive}*`] = 'deny';
  }

  // Recursive deletion of the OS itself, and of a filesystem root.
  rules['*Remove-Item*C:\\Windows*'] = 'deny';
  rules['*rm -rf /*'] = 'deny';
  rules['*rm -fr /*'] = 'deny';

  // Everything not named is permitted. The boundary asked for was core disk,
  // OS, boot and registry — not "ask about everything", which would make an
  // unattended agent useless and train whoever reads the log to ignore it.
  rules['*'] = 'allow';

  // `patterns` is the profile's own regex list. It is not translated, but its
  // length is worth knowing at the call site, and referencing it keeps the
  // signature honest about what this does and does not consume.
  void patterns;
  return rules;
}

/**
 * Writes a per-session config exposing Simba's MCP server.
 *
 * OpenCode has no `--mcp-config` flag; it reads `opencode.json` from the project
 * directory or the global config dir. Writing into the project directory would
 * mean dropping a file into the user's repos, so this generates a config in the
 * scratch area and points `OPENCODE_CONFIG` at it — verified to be honoured via
 * `opencode debug config`. Nothing is left behind in the working tree.
 */
async function writeSessionConfig(spec: LaunchSpec): Promise<string | null> {
  const deny = spec.denyPatterns ?? [];
  // Written whenever there is either MCP to expose or a boundary to enforce.
  // Previously this returned early without an MCP path, which would have
  // silently skipped the deny rules too.
  if (!spec.mcpConfigPath && deny.length === 0) return null;

  const dir = join(tmpdir(), 'simba-opencode');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${spec.sessionId}.json`);

  const server = join(config.root, 'dist', 'mcp-server.mjs');
  const cfg: Record<string, unknown> = { $schema: 'https://opencode.ai/config.json' };

  if (spec.mcpConfigPath) {
    cfg.mcp = {
      simba: {
        type: 'local',
        command: [process.execPath, server],
        enabled: true,
        environment: {
          SIMBA_AGENT_ID: spec.agentId,
          SIMBA_SESSION_ID: spec.sessionId,
        },
      },
    };
  }

  if (deny.length > 0) {
    cfg.permission = { bash: denyRulesFor(deny), edit: 'allow' };
  }

  await writeFile(path, JSON.stringify(cfg, null, 2), 'utf8');
  return path;
}

/** The brief goes to a file because it will not fit on a Windows command line. */
async function writeBriefFile(spec: LaunchSpec, brief: string): Promise<string> {
  const dir = join(tmpdir(), 'simba-opencode');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${spec.sessionId}-brief.md`);
  await writeFile(path, brief, 'utf8');
  return path;
}

class OpenCodeSession implements RunnerSession {
  readonly capabilities = CAPABILITIES;
  nativeSessionId: string | null = null;

  private readonly queue = new AsyncQueue<RunnerEvent>();
  private proc: ChildProcessWithoutNullStreams | null = null;
  private closed = false;
  private readonly pending: string[] = [];
  private turnActive = false;
  private announced = false;

  /** Accumulated across the turn's steps; a turn has several `step_finish`. */
  private turnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  private turnStartedAt = 0;
  private lastText: string | null = null;
  private sawError: string | null = null;

  /** Set for exactly one turn when the caller asked to branch the conversation. */
  private forkNext = false;

  constructor(
    readonly sessionId: string,
    private readonly spec: LaunchSpec,
    private readonly bin: { path: string; prefixArgs: string[] },
    private readonly configPath: string | null,
    private readonly briefPath: string | null,
  ) {
    this.nativeSessionId = spec.resumeSessionId ?? null;
  }

  get alive(): boolean {
    return !this.closed;
  }

  /** Branch the next turn off the current session instead of continuing it. */
  forkOnNextTurn(): void {
    this.forkNext = true;
  }

  private runTurn(prompt: string): void {
    if (this.closed) return;
    this.turnActive = true;
    this.turnStartedAt = Date.now();
    this.turnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    this.lastText = null;
    this.sawError = null;

    const args = [...this.bin.prefixArgs, 'run', '--format', 'json'];

    // --pure skips external plugins: a worker should behave identically every
    // run, and whatever the user has installed globally is not part of that.
    args.push('--pure');

    // Autonomous by design: nobody is present to answer a prompt. --auto
    // approves anything not *explicitly denied*, and the deny rules generated
    // from the agent's permission profile are what make that safe rather than
    // unconditional. An earlier version of this comment claimed the profile
    // enforced the list on its own; it did not, and nothing did.
    args.push('--auto');

    args.push('--dir', this.spec.cwd);

    // Attached only on the opening turn — a resumed session already has the
    // brief in its history, and re-sending it every turn would re-pay for
    // context the model can already see.
    //
    // `--file=` rather than `-f <path>`: the flag is declared as an array, so
    // the space-separated form greedily consumes the next argument too. That
    // silently ate the prompt and the turn failed with "File not found: Do
    // exactly two things and report what happened…" — the message itself being
    // reported as a missing filename. The `=` form binds exactly one value, and
    // a real flag follows it below so the array is terminated either way.
    if (this.briefPath && !this.nativeSessionId) {
      args.push(`--file=${this.briefPath}`);
    }

    if (this.nativeSessionId) {
      args.push('-s', this.nativeSessionId);
      // --fork requires --session or --continue, hence its placement here.
      if (this.forkNext) {
        args.push('--fork');
        this.forkNext = false;
      }
    }

    args.push('-m', resolveModel(this.spec.brain, this.spec.modelTier));

    if (this.spec.effort) args.push('--variant', this.spec.effort);

    // The message goes last, after every flag, so nothing can absorb it.
    args.push(prompt);

    const env: NodeJS.ProcessEnv = { ...process.env, ...this.spec.brain.env, ...this.spec.env };
    if (this.configPath) env.OPENCODE_CONFIG = this.configPath;

    const invocation = buildSpawn(this.bin.path, args);
    if (process.env.SIMBA_DEBUG) {
      console.error('[opencode] argv:', JSON.stringify(args));
    }
    const proc = spawn(invocation.command, invocation.args, {
      cwd: this.spec.cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    }) as ChildProcessWithoutNullStreams;

    this.proc = proc;

    // Closed immediately. opencode waits on stdin with no terminal attached and
    // will never start the turn otherwise — it presents as a timeout with empty
    // output, which reads like the free tier being down rather than a process
    // that never began.
    try {
      proc.stdin.end();
    } catch {
      /* already closed */
    }

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => this.onLine(line));

    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
      if (stderr.length > 16_384) stderr = stderr.slice(-8192);
    });

    proc.on('error', (err) => {
      this.emit({
        kind: 'error',
        sessionId: this.sessionId,
        raw: { message: err.message },
        at: new Date(),
        message: `failed to spawn opencode: ${err.message}`,
      });
      this.finish();
    });

    proc.on('close', (code) => {
      this.turnActive = false;
      this.proc = null;
      this.closeTurn(code, stderr);

      const next = this.pending.shift();
      if (next !== undefined) {
        this.runTurn(next);
        return;
      }

      // Idle, not dead: the session id survives, so the next message resumes it
      // in a fresh process.
      this.emit({
        kind: 'exit',
        sessionId: this.sessionId,
        raw: { code },
        at: new Date(),
        code,
        signal: null,
      });
    });
  }

  /** Emits the turn_end that the rest of the system accounts against. */
  private closeTurn(code: number | null, stderr: string): void {
    const failed = this.sawError !== null || (code !== 0 && !this.lastText);
    const message = this.sawError ?? (stderr.trim() ? stderr.trim().slice(0, 4000) : null);

    if (failed && message) {
      const authFailure = /not logged in|unauthor|forbidden|not licensed|401|403/i.test(message);
      this.emit({
        kind: 'error',
        sessionId: this.sessionId,
        raw: { stderr, code, message },
        at: new Date(),
        message,
        authFailure,
      });

      // No structured limit event exists here, so exhaustion is inferred from
      // the failure text and reported without a reset time. The supervisor
      // treats a resetless limit as "unusable, no schedule to wake against"
      // rather than benching the brain forever.
      if (/rate limit|quota|usage limit|too many requests|429|capacity/i.test(message)) {
        this.emit({
          kind: 'rate_limit',
          sessionId: this.sessionId,
          raw: { message },
          at: new Date(),
          status: 'exhausted',
          limitType: null,
          resetsAt: null,
          overageStatus: null,
          overageResetsAt: null,
          isUsingOverage: false,
        });
      }
    }

    this.emit({
      kind: 'turn_end',
      sessionId: this.sessionId,
      raw: { code },
      at: new Date(),
      isError: failed,
      stopReason: failed ? 'error' : 'end_turn',
      resultText: this.lastText,
      error: failed ? message : null,
      durationMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : null,
      usage: {
        model: resolveModel(this.spec.brain, this.spec.modelTier),
        inputTokens: this.turnUsage.input,
        outputTokens: this.turnUsage.output,
        cacheReadTokens: this.turnUsage.cacheRead,
        cacheCreationTokens: this.turnUsage.cacheWrite,
        // Reported by opencode itself, not assumed. It is 0 on the free tier,
        // and will not be 0 if the user later configures a paid provider — so
        // this stays honest either way.
        costUsd: this.turnUsage.cost,
      },
    });
  }

  private emit(e: RunnerEvent): void {
    this.queue.push(e);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.close();
  }

  private announce(nativeId: string): void {
    this.nativeSessionId = nativeId;
    if (this.announced) return;
    this.announced = true;
    this.emit({
      kind: 'init',
      sessionId: this.sessionId,
      raw: { sessionID: nativeId },
      at: new Date(),
      nativeSessionId: nativeId,
      model: resolveModel(this.spec.brain, this.spec.modelTier),
      cwd: this.spec.cwd,
      permissionMode: 'auto',
      // Subscription-free: the free tier needs no key at all.
      apiKeySource: 'none',
      tools: [],
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    const part = (obj.part ?? {}) as Record<string, unknown>;
    const base = { sessionId: this.sessionId, raw: obj, at: new Date() };

    // Every event carries the native session id, so the resume key is captured
    // from whichever arrives first rather than depending on one event type.
    const nativeId = typeof part.sessionID === 'string' ? part.sessionID : null;
    if (nativeId) this.announce(nativeId);

    switch (obj.type) {
      case 'text': {
        const text = typeof part.text === 'string' ? part.text : '';
        if (!text) return;
        this.lastText = this.lastText ? `${this.lastText}${text}` : text;
        this.emit({ ...base, kind: 'text', role: 'assistant', text, partial: false });
        return;
      }

      case 'reasoning': {
        const text = typeof part.text === 'string' ? part.text : '';
        if (text) this.emit({ ...base, kind: 'reasoning', text });
        return;
      }

      case 'tool_use': {
        const state = (part.state ?? {}) as Record<string, unknown>;
        const status = String(state.status ?? '');
        // Tools are announced when started and again when finished. Only the
        // completed form carries output, and emitting the pending one too would
        // double every row in tool_calls.
        if (status && status !== 'completed' && status !== 'error') return;

        const id = String(part.callID ?? part.id ?? `oc_${Date.now()}`);
        const name = String(part.tool ?? 'tool');
        this.emit({ ...base, kind: 'tool_call', toolUseId: id, name, args: state.input ?? {} });

        const output = state.output;
        this.emit({
          ...base,
          kind: 'tool_result',
          toolUseId: id,
          result: state,
          resultText: typeof output === 'string' ? output : output ? JSON.stringify(output) : null,
          isError: status === 'error',
        });
        return;
      }

      case 'step_finish': {
        const tokens = (part.tokens ?? {}) as Record<string, unknown>;
        const cache = (tokens.cache ?? {}) as Record<string, unknown>;
        const usage: Omit<UsageEvent, 'kind' | 'sessionId' | 'raw' | 'at'> = {
          model: resolveModel(this.spec.brain, this.spec.modelTier),
          inputTokens: Number(tokens.input ?? 0),
          outputTokens: Number(tokens.output ?? 0),
          cacheReadTokens: Number(cache.read ?? 0),
          cacheCreationTokens: Number(cache.write ?? 0),
          costUsd: Number(part.cost ?? 0),
        };

        this.turnUsage.input += usage.inputTokens;
        this.turnUsage.output += usage.outputTokens;
        this.turnUsage.cacheRead += usage.cacheReadTokens;
        this.turnUsage.cacheWrite += usage.cacheCreationTokens;
        this.turnUsage.cost += usage.costUsd;

        this.emit({ ...base, kind: 'usage', ...usage });
        return;
      }

      case 'error': {
        const err = (obj.error ?? {}) as { data?: { message?: string }; message?: string };
        this.sawError = err.data?.message ?? err.message ?? 'opencode error';
        return;
      }

      default:
        return;
    }
  }

  events(): AsyncIterableIterator<RunnerEvent> {
    return this.queue.iterator();
  }

  async send(text: string): Promise<void> {
    if (this.closed) throw new Error('session is closed');
    if (this.turnActive) {
      this.pending.push(text);
      return;
    }
    this.runTurn(text);
  }

  async interrupt(): Promise<void> {
    await this.kill();
  }

  async kill(): Promise<void> {
    this.pending.length = 0;
    const proc = this.proc;
    if (proc) {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
    this.finish();
  }
}

export class OpenCodeRunner implements Runner {
  readonly cli = 'opencode';
  readonly capabilities = CAPABILITIES;

  async launch(spec: LaunchSpec): Promise<RunnerSession> {
    const bin = await resolveExecutor('opencode');
    if (!bin) throw new Error('opencode CLI not found on this machine');

    const configPath = await writeSessionConfig(spec);
    // The boundary rides along with the brief. Appended rather than sent
    // separately so it cannot be dropped by a caller that omits one of them.
    const briefBody = (spec.systemPromptAppend ?? '') + denyNotice(spec.denyPatterns ?? []);
    const briefPath = briefBody.trim() ? await writeBriefFile(spec, briefBody) : null;

    const session = new OpenCodeSession(spec.sessionId, spec, bin, configPath, briefPath);
    if (spec.prompt) await session.send(spec.prompt);
    return session;
  }

  /**
   * Sessions live in opencode's own storage, keyed by id. There is one free-tier
   * login rather than several accounts to isolate, so a resume is possible
   * whenever the store still holds the session — no per-account check applies.
   */
  async canResume(_brain: BrainAccount, nativeSessionId: string): Promise<boolean> {
    if (!nativeSessionId.startsWith('ses_')) return false;
    const store = join(
      process.env.USERPROFILE ?? process.env.HOME ?? '',
      '.local',
      'share',
      'opencode',
    );
    return existsSync(store);
  }
}
