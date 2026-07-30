import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { AsyncQueue } from './queue.js';
import { resolveExecutor } from './discovery.js';
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
 * Claude Code runner.
 *
 * Long-lived process per session using streaming stdin and stdout, rather than
 * a fresh process per turn. The process is treated as a cache, never as truth:
 * if it dies, the transcript is already in Postgres and the session is
 * rehydrated. That is what makes the fragility of a long-lived process on a
 * machine that sleeps acceptable.
 *
 * Account isolation is entirely CLAUDE_CONFIG_DIR — verified in spike zero to
 * fully separate credentials, transcripts and settings between accounts.
 */

/**
 * Resolved once at launch via discovery rather than hardcoded: an update that
 * relocates the binary should not take the whole runner down.
 */
let CLAUDE_BIN = process.env.SIMBA_CLAUDE_BIN ?? join(homedir(), '.local', 'bin', 'claude.exe');

const CAPABILITIES: ReadonlySet<RunnerCapability> = new Set<RunnerCapability>([
  'stream',
  'steer',
  'resume',
  'worktree',
  'budget',
]);

function resolveModel(brain: BrainAccount, tier: ModelTier): string {
  return brain.tierModels[tier] ?? (tier === 'high' ? 'opus' : tier === 'mid' ? 'sonnet' : 'haiku');
}

function epochToDate(v: unknown): Date | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  // The CLI reports seconds; guard against a future switch to milliseconds.
  return new Date(v > 1e12 ? v : v * 1000);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && 'text' in b && typeof (b as { text: unknown }).text === 'string'
          ? (b as { text: string }).text
          : '',
      )
      .join('');
  }
  return '';
}

class ClaudeSession implements RunnerSession {
  readonly capabilities = CAPABILITIES;
  nativeSessionId: string | null = null;

  private readonly queue = new AsyncQueue<RunnerEvent>();
  private proc: ChildProcessWithoutNullStreams | null = null;
  private exited = false;

  constructor(
    readonly sessionId: string,
    private readonly spec: LaunchSpec,
  ) {}

  get alive(): boolean {
    return !this.exited && this.proc !== null;
  }

  start(): void {
    const args = this.buildArgs();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.spec.brain.env,
      ...this.spec.env,
    };

    // The isolation mechanism. Without this every account collapses into one.
    if (this.spec.brain.configDir) {
      env.CLAUDE_CONFIG_DIR = this.spec.brain.configDir;
    }

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: this.spec.cwd,
      env,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    this.proc = proc;

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => this.onLine(line));

    let stderrBuf = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 16_384) stderrBuf = stderrBuf.slice(-8192);
    });

    proc.on('error', (err) => {
      this.emit({
        kind: 'error',
        sessionId: this.sessionId,
        raw: { message: err.message },
        at: new Date(),
        message: `failed to spawn claude: ${err.message}`,
      });
      this.finish();
    });

    proc.on('close', (code, signal) => {
      if (stderrBuf.trim()) {
        this.emit({
          kind: 'error',
          sessionId: this.sessionId,
          raw: { stderr: stderrBuf },
          at: new Date(),
          message: stderrBuf.trim().slice(0, 4000),
          authFailure: /not logged in|please run \/login|unauthor/i.test(stderrBuf),
        });
      }
      this.emit({
        kind: 'exit',
        sessionId: this.sessionId,
        raw: { code, signal },
        at: new Date(),
        code,
        signal: signal ?? null,
      });
      this.finish();
    });
  }

  private buildArgs(): string[] {
    const s = this.spec;
    const args: string[] = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--replay-user-messages',
      '--permission-mode',
      'bypassPermissions',
      '--model',
      resolveModel(s.brain, s.modelTier),
    ];

    if (s.resumeSessionId) {
      args.push('--resume', s.resumeSessionId);
    } else {
      args.push('--session-id', s.sessionId);
    }

    if (s.systemPromptAppend) args.push('--append-system-prompt', s.systemPromptAppend);
    if (s.settingsPath) args.push('--settings', s.settingsPath);
    if (s.mcpConfigPath) args.push('--mcp-config', s.mcpConfigPath, '--strict-mcp-config');
    if (s.maxBudgetUsd != null) args.push('--max-budget-usd', String(s.maxBudgetUsd));
    if (s.effort) args.push('--effort', s.effort);

    return args;
  }

  private emit(e: RunnerEvent): void {
    this.queue.push(e);
  }

  private finish(): void {
    if (this.exited) return;
    this.exited = true;
    this.queue.close();
  }

  /**
   * Normalizes one stream-json line. Unrecognized event types are dropped from
   * the normalized stream but their raw payload is still surfaced, so a CLI
   * update that adds an event type degrades to "unknown" rather than to a crash.
   */
  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    const at = new Date();
    const base = { sessionId: this.sessionId, raw: obj, at };
    const type = obj.type as string | undefined;

    switch (type) {
      case 'system': {
        if (obj.subtype !== 'init') return;
        this.nativeSessionId = (obj.session_id as string) ?? this.sessionId;
        this.emit({
          ...base,
          kind: 'init',
          nativeSessionId: this.nativeSessionId,
          model: (obj.model as string) ?? null,
          cwd: (obj.cwd as string) ?? null,
          permissionMode: (obj.permissionMode as string) ?? null,
          apiKeySource: (obj.apiKeySource as string) ?? null,
          tools: Array.isArray(obj.tools) ? (obj.tools as string[]) : [],
        });
        return;
      }

      case 'rate_limit_event': {
        const info = (obj.rate_limit_info ?? {}) as Record<string, unknown>;
        this.emit({
          ...base,
          kind: 'rate_limit',
          status: (info.status as string) ?? 'unknown',
          limitType: (info.rateLimitType as string) ?? null,
          resetsAt: epochToDate(info.resetsAt),
          overageStatus: (info.overageStatus as string) ?? null,
          overageResetsAt: epochToDate(info.overageResetsAt),
          isUsingOverage: Boolean(info.isUsingOverage),
        });
        return;
      }

      case 'assistant':
      case 'user': {
        const msg = (obj.message ?? {}) as Record<string, unknown>;
        const content = msg.content;
        if (!Array.isArray(content)) {
          const text = textOf(content);
          if (text) {
            this.emit({
              ...base,
              kind: 'text',
              role: type === 'assistant' ? 'assistant' : 'user',
              text,
              partial: false,
            });
          }
          return;
        }

        for (const block of content as Array<Record<string, unknown>>) {
          switch (block.type) {
            case 'text':
              // User-role text on this stream is only ever our own input coming
              // back: --replay-user-messages echoes injected messages so the
              // sender can confirm receipt. The caller already persisted it, so
              // emitting here would duplicate every user turn.
              if (type === 'user') break;
              this.emit({
                ...base,
                kind: 'text',
                role: 'assistant',
                text: String(block.text ?? ''),
                partial: false,
              });
              break;
            case 'thinking':
            case 'redacted_thinking':
              this.emit({
                ...base,
                kind: 'reasoning',
                text: String(block.thinking ?? block.text ?? ''),
              });
              break;
            case 'tool_use':
              this.emit({
                ...base,
                kind: 'tool_call',
                toolUseId: String(block.id ?? ''),
                name: String(block.name ?? 'unknown'),
                args: block.input ?? null,
              });
              break;
            case 'tool_result': {
              const raw = block.content;
              this.emit({
                ...base,
                kind: 'tool_result',
                toolUseId: String(block.tool_use_id ?? ''),
                result: raw ?? null,
                resultText: textOf(raw) || null,
                isError: Boolean(block.is_error),
              });
              break;
            }
            default:
              break;
          }
        }
        return;
      }

      case 'stream_event': {
        // Token-level deltas from --include-partial-messages. Emitted for live
        // display only; persistence uses the assembled message events above.
        const event = (obj.event ?? {}) as Record<string, unknown>;
        const delta = (event.delta ?? {}) as Record<string, unknown>;
        if (typeof delta.text === 'string' && delta.text) {
          this.emit({ ...base, kind: 'text', role: 'assistant', text: delta.text, partial: true });
        }
        return;
      }

      case 'result': {
        const usage = (obj.usage ?? {}) as Record<string, number>;
        const isError = Boolean(obj.is_error);
        this.emit({
          ...base,
          kind: 'turn_end',
          // Guard: a logged-out response carries subtype "success" alongside
          // is_error true, so subtype must never be the error signal.
          isError,
          stopReason: (obj.stop_reason as string) ?? null,
          resultText: typeof obj.result === 'string' ? obj.result : null,
          error: isError && typeof obj.result === 'string' ? obj.result : null,
          durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : null,
          usage: {
            model: (obj.model as string) ?? null,
            inputTokens: Number(usage.input_tokens ?? 0),
            outputTokens: Number(usage.output_tokens ?? 0),
            cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
            cacheCreationTokens: Number(usage.cache_creation_input_tokens ?? 0),
            costUsd: Number(obj.total_cost_usd ?? 0),
          },
        });

        if (isError && typeof obj.result === 'string' && /not logged in|\/login/i.test(obj.result)) {
          this.emit({
            ...base,
            kind: 'error',
            message: obj.result,
            authFailure: true,
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
    if (!this.proc || this.exited) throw new Error('session is not running');
    const payload = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: this.nativeSessionId ?? this.sessionId,
    };
    await new Promise<void>((resolve, reject) => {
      this.proc!.stdin.write(JSON.stringify(payload) + '\n', (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  /**
   * No verified in-band interrupt control message exists for stream-json input,
   * so this is not advertised as a capability. Killing the process ends the
   * turn; the transcript is already durable and the session can be resumed.
   */
  async interrupt(): Promise<void> {
    await this.kill();
  }

  async kill(): Promise<void> {
    if (!this.proc || this.exited) return;
    try {
      this.proc.stdin.end();
    } catch {
      /* stdin may already be closed */
    }
    this.proc.kill();
    // Windows ignores SIGTERM for detached console apps often enough that a
    // hard follow-up is worth scheduling.
    const proc = this.proc;
    setTimeout(() => {
      if (!this.exited) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, 3000).unref();
  }
}

export class ClaudeRunner implements Runner {
  readonly cli = 'claude';
  readonly capabilities = CAPABILITIES;

  async launch(spec: LaunchSpec): Promise<RunnerSession> {
    const bin = await resolveExecutor('claude');
    if (bin) CLAUDE_BIN = bin.path;

    const session = new ClaudeSession(spec.sessionId, spec);
    session.start();
    if (spec.prompt) {
      // The process needs a moment to open stdin before the first write lands.
      await new Promise((r) => setTimeout(r, 150));
      await session.send(spec.prompt);
    }
    return session;
  }

  /**
   * A native resume is only possible if the transcript exists inside that
   * account's config dir. This is also the check that drives the cheap
   * same-tool failover path: if account B lacks the transcript, copy it first.
   */
  async canResume(brain: BrainAccount, nativeSessionId: string): Promise<boolean> {
    const dir = brain.configDir;
    if (!dir || !existsSync(dir)) return false;
    return (await findTranscript(dir, nativeSessionId)) !== null;
  }
}

/**
 * Locates a session transcript within a config directory. Claude Code stores
 * these as `<configDir>/projects/<slugified-cwd>/<session-id>.jsonl`, but the
 * slug depends on the working directory, so this scans rather than guesses.
 */
export async function findTranscript(
  configDir: string,
  nativeSessionId: string,
): Promise<string | null> {
  const projectsDir = join(configDir, 'projects');
  if (!existsSync(projectsDir)) return null;

  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const candidate = join(projectsDir, entry, `${nativeSessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Reads a transcript's raw JSONL lines, used when migrating a session between accounts. */
export async function readTranscript(path: string): Promise<string[]> {
  const content = await readFile(path, 'utf8');
  return content.split('\n').filter((l) => l.trim().length > 0);
}
