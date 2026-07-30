import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

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
} from './types.js';

/**
 * Codex CLI runner.
 *
 * Materially different from Claude Code, and the differences are the reason the
 * runner contract advertises capabilities instead of assuming them:
 *
 *   - `codex exec` is **one-shot**. A prompt goes in, the turn runs, the
 *     process exits. Continuing means `codex exec resume <thread-id> <prompt>`,
 *     a fresh process each time. There is no streaming stdin, so there is no
 *     mid-turn steering — messages queue until the next turn. Advertised
 *     capabilities are `{stream, resume}` and deliberately not `steer`.
 *   - Usage is reported as **tokens only**; there is no cost figure. Cost stays
 *     zero for Codex turns rather than being invented from a guessed price
 *     table, and token counts carry the accounting.
 *   - There is no equivalent of Claude's `rate_limit_event`. Exhaustion shows up
 *     as a failed turn, so detection here is reactive — which is precisely why
 *     checkpoints are written every turn rather than only on a predicted limit.
 *
 * Isolation is `CODEX_HOME`, confirmed in vibe-kanban's adapter and in the
 * CLI's own help text ("auth still uses CODEX_HOME").
 */

const CAPABILITIES: ReadonlySet<RunnerCapability> = new Set<RunnerCapability>([
  'stream',
  'resume',
]);

function resolveModel(brain: BrainAccount, tier: ModelTier): string | null {
  return brain.tierModels[tier] ?? null;
}

class CodexSession implements RunnerSession {
  readonly capabilities = CAPABILITIES;
  nativeSessionId: string | null = null;

  private readonly queue = new AsyncQueue<RunnerEvent>();
  private proc: ChildProcessWithoutNullStreams | null = null;
  private closed = false;
  /** Queued while a turn is executing; drained when the process exits. */
  private readonly pending: string[] = [];
  private turnActive = false;

  constructor(
    readonly sessionId: string,
    private readonly spec: LaunchSpec,
    private readonly bin: { path: string; prefixArgs: string[] },
  ) {
    this.nativeSessionId = spec.resumeSessionId ?? null;
  }

  get alive(): boolean {
    return !this.closed;
  }

  /** Runs one turn as its own process, then settles back to idle. */
  private runTurn(prompt: string): void {
    if (this.closed) return;
    this.turnActive = true;

    const args = [...this.bin.prefixArgs, 'exec'];

    if (this.nativeSessionId) args.push('resume', this.nativeSessionId);

    args.push(
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      this.spec.cwd,
    );

    const model = resolveModel(this.spec.brain, this.spec.modelTier);
    if (model) args.push('-m', model);

    // The hydration brief has no dedicated flag here, so it is prepended to the
    // prompt on the opening turn. Lossier than Claude's --append-system-prompt,
    // which is one more reason cross-tool sits below same-tool in the chain.
    const body =
      !this.nativeSessionId && this.spec.systemPromptAppend
        ? `${this.spec.systemPromptAppend}\n\n---\n\n${prompt}`
        : prompt;

    // The prompt goes in over stdin ("-"), never as an argument. A hydration
    // brief runs to tens of kilobytes and Windows caps a command line near 32k,
    // so passing it as argv would truncate or fail outright on exactly the
    // sessions that need the most context. It also keeps arbitrary prompt text
    // away from shell quoting entirely.
    args.push('-');

    const env: NodeJS.ProcessEnv = { ...process.env, ...this.spec.brain.env, ...this.spec.env };
    if (this.spec.brain.configDir) env.CODEX_HOME = this.spec.brain.configDir;

    const invocation = buildSpawn(this.bin.path, args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: this.spec.cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    }) as ChildProcessWithoutNullStreams;

    this.proc = proc;

    // Write the prompt, then close: codex waits on stdin and will not start the
    // turn until the stream ends.
    try {
      proc.stdin.write(body);
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
        message: `failed to spawn codex: ${err.message}`,
      });
      this.finish();
    });

    proc.on('close', (code) => {
      this.turnActive = false;
      this.proc = null;

      if (code !== 0 && stderr.trim()) {
        const authFailure = /not logged in|unauthor|login|401/i.test(stderr);
        const limited = /rate limit|quota|usage limit|too many requests|429/i.test(stderr);
        this.emit({
          kind: 'error',
          sessionId: this.sessionId,
          raw: { stderr, code },
          at: new Date(),
          message: stderr.trim().slice(0, 4000),
          authFailure,
        });
        if (limited) {
          // Codex gives no structured limit event and no reset time, so the
          // supervisor is told the brain is unusable without a schedule to
          // wake against.
          this.emit({
            kind: 'rate_limit',
            sessionId: this.sessionId,
            raw: { stderr },
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

      const next = this.pending.shift();
      if (next !== undefined) {
        this.runTurn(next);
        return;
      }

      // Idle rather than dead: the thread id survives, so the next message
      // resumes it in a new process.
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

  private emit(e: RunnerEvent): void {
    this.queue.push(e);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.close();
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

    const base = { sessionId: this.sessionId, raw: obj, at: new Date() };

    switch (obj.type) {
      case 'thread.started': {
        this.nativeSessionId = String(obj.thread_id ?? '') || this.nativeSessionId;
        this.emit({
          ...base,
          kind: 'init',
          nativeSessionId: this.nativeSessionId ?? this.sessionId,
          model: resolveModel(this.spec.brain, this.spec.modelTier),
          cwd: this.spec.cwd,
          permissionMode: 'bypass',
          apiKeySource: null,
          tools: [],
        });
        return;
      }

      case 'item.completed': {
        const item = (obj.item ?? {}) as Record<string, unknown>;
        const itemType = String(item.type ?? '');

        switch (itemType) {
          case 'agent_message':
            this.emit({
              ...base,
              kind: 'text',
              role: 'assistant',
              text: String(item.text ?? ''),
              partial: false,
            });
            return;

          case 'reasoning':
            this.emit({ ...base, kind: 'reasoning', text: String(item.text ?? '') });
            return;

          // Codex reports non-fatal problems (unknown model metadata, an
          // unsupported service tier) as completed items rather than failures.
          // Surfaced as warnings so they land in the audit log instead of
          // vanishing, which is how an invalid model id stayed invisible.
          case 'error':
            this.emit({
              ...base,
              kind: 'error',
              message: String(item.message ?? 'codex reported an error'),
              authFailure: /not logged in|unauthor|401/i.test(String(item.message ?? '')),
            });
            return;

          // Codex reports a completed action as a single item rather than a
          // call/result pair, so both halves are emitted together to keep the
          // tool_calls table shaped the same across tools.
          case 'command_execution': {
            const id = String(item.id ?? `codex_${Date.now()}`);
            const failed = item.exit_code !== undefined && Number(item.exit_code) !== 0;
            this.emit({
              ...base,
              kind: 'tool_call',
              toolUseId: id,
              name: 'Bash',
              args: { command: item.command ?? item.aggregated_command ?? '' },
            });
            this.emit({
              ...base,
              kind: 'tool_result',
              toolUseId: id,
              result: item,
              resultText: String(item.aggregated_output ?? item.output ?? ''),
              isError: failed,
            });
            return;
          }

          case 'file_change':
          case 'patch_apply': {
            const id = String(item.id ?? `codex_${Date.now()}`);
            this.emit({
              ...base,
              kind: 'tool_call',
              toolUseId: id,
              name: 'Edit',
              args: item,
            });
            this.emit({
              ...base,
              kind: 'tool_result',
              toolUseId: id,
              result: item,
              resultText: String(item.status ?? 'applied'),
              isError: String(item.status ?? '') === 'failed',
            });
            return;
          }

          case 'mcp_tool_call': {
            const id = String(item.id ?? `codex_${Date.now()}`);
            this.emit({
              ...base,
              kind: 'tool_call',
              toolUseId: id,
              name: String(item.tool ?? item.server ?? 'mcp'),
              args: item.arguments ?? item,
            });
            this.emit({
              ...base,
              kind: 'tool_result',
              toolUseId: id,
              result: item,
              resultText: String(item.result ?? ''),
              isError: String(item.status ?? '') === 'failed',
            });
            return;
          }

          default:
            return;
        }
      }

      case 'turn.completed': {
        const usage = (obj.usage ?? {}) as Record<string, number>;
        this.emit({
          ...base,
          kind: 'turn_end',
          isError: false,
          stopReason: 'end_turn',
          resultText: null,
          error: null,
          durationMs: null,
          usage: {
            model: resolveModel(this.spec.brain, this.spec.modelTier),
            inputTokens: Number(usage.input_tokens ?? 0),
            outputTokens: Number(usage.output_tokens ?? 0),
            cacheReadTokens: Number(usage.cached_input_tokens ?? 0),
            cacheCreationTokens: Number(usage.cache_write_input_tokens ?? 0),
            // Codex reports no cost. Left at zero rather than fabricated from a
            // price table that would silently drift out of date.
            costUsd: 0,
          },
        });
        return;
      }

      // Top-level transport/API failure, distinct from an error item.
      case 'error': {
        const message = String(obj.message ?? 'codex error');
        this.emit({
          ...base,
          kind: 'error',
          message,
          authFailure: /not logged in|unauthor|401/i.test(message),
        });
        return;
      }

      case 'turn.failed': {
        const error = (obj.error ?? {}) as Record<string, unknown>;
        const message = String(error.message ?? 'turn failed');
        this.emit({
          ...base,
          kind: 'turn_end',
          isError: true,
          stopReason: 'error',
          resultText: null,
          error: message,
          durationMs: null,
          usage: null,
        });
        if (/rate limit|quota|usage limit|429/i.test(message)) {
          this.emit({
            ...base,
            kind: 'rate_limit',
            status: 'exhausted',
            limitType: null,
            resetsAt: null,
            overageStatus: null,
            overageResetsAt: null,
            isUsingOverage: false,
          });
        }
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
      // No streaming stdin: the message waits for the current turn to finish.
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

export class CodexRunner implements Runner {
  readonly cli = 'codex';
  readonly capabilities = CAPABILITIES;

  async launch(spec: LaunchSpec): Promise<RunnerSession> {
    const bin = await resolveExecutor('codex');
    if (!bin) throw new Error('codex CLI not found on this machine');

    const session = new CodexSession(spec.sessionId, spec, bin);
    if (spec.prompt) await session.send(spec.prompt);
    return session;
  }

  /**
   * Codex persists threads under `$CODEX_HOME/sessions`. Unlike Claude Code
   * there is no documented way to transplant a thread between accounts, so a
   * codex-to-codex swap across two ChatGPT logins is not the cheap file-copy
   * path — it would be a rehydration like any other cross-tool move. Moot for
   * now: there is only one ChatGPT subscription.
   */
  async canResume(brain: BrainAccount, nativeSessionId: string): Promise<boolean> {
    const home = brain.configDir;
    if (!home || !existsSync(home)) return false;

    const sessionsDir = join(home, 'sessions');
    if (!existsSync(sessionsDir)) return false;

    return containsSession(sessionsDir, nativeSessionId, 4);
  }
}

/** Codex nests session files in dated subdirectories, so this walks a few levels. */
async function containsSession(dir: string, id: string, depth: number): Promise<boolean> {
  if (depth <= 0) return false;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.includes(id)) return true;
    if (entry.isDirectory() && (await containsSession(join(dir, entry.name), id, depth - 1))) {
      return true;
    }
  }
  return false;
}
