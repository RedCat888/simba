import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { config } from '../config.js';

import { AsyncQueue } from './queue.js';
import { resolveExecutor, buildSpawn } from './discovery.js';
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
 * Writes a per-session config exposing Simba's MCP server.
 *
 * OpenCode has no `--mcp-config` flag; it reads `opencode.json` from the project
 * directory or the global config dir. Writing into the project directory would
 * mean dropping a file into the user's repos, so this generates a config in the
 * scratch area and points `OPENCODE_CONFIG` at it — verified to be honoured via
 * `opencode debug config`. Nothing is left behind in the working tree.
 */
async function writeSessionConfig(spec: LaunchSpec): Promise<string | null> {
  if (!spec.mcpConfigPath) return null;

  const dir = join(tmpdir(), 'simba-opencode');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${spec.sessionId}.json`);

  const server = join(config.root, 'dist', 'mcp-server.mjs');
  await writeFile(
    path,
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        mcp: {
          simba: {
            type: 'local',
            command: [process.execPath, server],
            enabled: true,
            environment: {
              SIMBA_AGENT_ID: spec.agentId,
              SIMBA_SESSION_ID: spec.sessionId,
            },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
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

    // Autonomous by design. Simba's deny list is enforced by the profile that
    // chose to launch this session, not by an interactive prompt nobody is
    // present to answer.
    args.push('--auto');

    args.push('--dir', this.spec.cwd);

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

    // Attached only on the opening turn — a resumed session already has the
    // brief in its own history, and re-attaching it every turn would re-pay the
    // tokens for context the model can already see.
    if (this.briefPath && !this.nativeSessionId) {
      args.push('-f', this.briefPath);
    }

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
    const briefPath = spec.systemPromptAppend
      ? await writeBriefFile(spec, spec.systemPromptAppend)
      : null;

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
