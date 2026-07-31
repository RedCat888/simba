import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

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
 * cursor-agent runner.
 *
 * STATUS: the flag surface below is taken from `cursor-agent --help` on this
 * machine and is accurate. The **event mapping is unverified** — no live stream
 * has been observed, and the normalization here is written against the
 * Claude-style stream-json shape the CLI's flags imply. Expect to correct it on
 * first real run; the raw payload is retained on every event so a mismatch is
 * diagnosable rather than silent.
 *
 * Why no live stream: `cursor-agent status` reports "Logged in (unable to fetch
 * user details)" while `--list-models` reports "No models available for this
 * account". The CLI is authenticated, so this is an entitlement problem rather
 * than a sign-in problem and re-authenticating will not resolve it.
 *
 * Confirmed from --help:
 *   -p --print                     non-interactive
 *   --output-format stream-json    structured stream
 *   --stream-partial-output        token deltas
 *   --resume [chatId] / --continue resume
 *   --model <model>                gpt-5, sonnet-4, sonnet-4-thinking
 *   -f --force (--yolo)            run without approval prompts
 *
 * There is no --input-format, so like Codex this is one turn per process:
 * messages queue rather than steering. Capabilities reflect that.
 *
 * Isolation: cursor-agent has no config-dir override. Separating two Cursor
 * logins on one machine would mean USERPROFILE spoofing or a second Windows
 * user — genuinely hacky. Moot here, since there is only one Cursor account.
 */

const CAPABILITIES: ReadonlySet<RunnerCapability> = new Set<RunnerCapability>([
  'stream',
  'resume',
]);

function resolveModel(brain: BrainAccount, tier: ModelTier): string | null {
  return brain.tierModels[tier] ?? null;
}

class CursorSession implements RunnerSession {
  readonly capabilities = CAPABILITIES;
  nativeSessionId: string | null = null;

  private readonly queue = new AsyncQueue<RunnerEvent>();
  private proc: ChildProcessWithoutNullStreams | null = null;
  private closed = false;
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

  private runTurn(prompt: string): void {
    if (this.closed) return;
    this.turnActive = true;

    const args = [...this.bin.prefixArgs, '--print', '--output-format', 'stream-json', '--force'];

    if (this.nativeSessionId) args.push('--resume', this.nativeSessionId);

    const model = resolveModel(this.spec.brain, this.spec.modelTier);
    if (model) args.push('--model', model);

    // Same framing as the Codex adapter: a bare prepended brief gets treated as
    // the instruction, and the model answers the brief rather than the task.
    const body =
      !this.nativeSessionId && this.spec.systemPromptAppend
        ? `<background>\nStanding context about your role. This is reference material, ` +
          `not your task.\n\n${this.spec.systemPromptAppend}\n</background>\n\n` +
          `# Your task for this session\n\n${prompt}`
        : prompt;

    const env: NodeJS.ProcessEnv = { ...process.env, ...this.spec.brain.env, ...this.spec.env };

    const invocation = buildSpawn(this.bin.path, args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: this.spec.cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    }) as ChildProcessWithoutNullStreams;

    this.proc = proc;

    // Prompt over stdin rather than argv, for the same reason as Codex: a
    // hydration brief can exceed the Windows command-line limit.
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
        message: `failed to spawn cursor-agent: ${err.message}`,
      });
      this.finish();
    });

    proc.on('close', (code) => {
      this.turnActive = false;
      this.proc = null;

      if (code !== 0 && stderr.trim()) {
        this.emit({
          kind: 'error',
          sessionId: this.sessionId,
          raw: { stderr, code },
          at: new Date(),
          message: stderr.trim().slice(0, 4000),
          // "No models available for this account" is an entitlement failure,
          // not a credential one, but it is equally unrecoverable by retrying —
          // so it is reported as an auth failure to take the brain out of the
          // chain. The recorded note distinguishes the two for a human reader.
          authFailure: /not logged in|unauthor|no models available|401/i.test(stderr),
        });
      }

      const next = this.pending.shift();
      if (next !== undefined) {
        this.runTurn(next);
        return;
      }

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
      case 'system': {
        const chatId = String(obj.chat_id ?? obj.session_id ?? '');
        if (chatId) this.nativeSessionId = chatId;
        this.emit({
          ...base,
          kind: 'init',
          nativeSessionId: this.nativeSessionId ?? this.sessionId,
          model: (obj.model as string) ?? resolveModel(this.spec.brain, this.spec.modelTier),
          cwd: this.spec.cwd,
          permissionMode: 'force',
          apiKeySource: null,
          tools: Array.isArray(obj.tools) ? (obj.tools as string[]) : [],
        });
        return;
      }

      case 'assistant':
      case 'user': {
        const msg = (obj.message ?? obj) as Record<string, unknown>;
        const content = msg.content;
        if (!Array.isArray(content)) return;

        for (const block of content as Array<Record<string, unknown>>) {
          switch (block.type) {
            case 'text':
              // User-role text is an echo of our own input, already persisted.
              if (obj.type === 'user') break;
              this.emit({
                ...base,
                kind: 'text',
                role: 'assistant',
                text: String(block.text ?? ''),
                partial: false,
              });
              break;
            case 'thinking':
              this.emit({ ...base, kind: 'reasoning', text: String(block.thinking ?? '') });
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
            case 'tool_result':
              this.emit({
                ...base,
                kind: 'tool_result',
                toolUseId: String(block.tool_use_id ?? ''),
                result: block.content ?? null,
                resultText:
                  typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
                isError: Boolean(block.is_error),
              });
              break;
            default:
              break;
          }
        }
        return;
      }

      case 'result': {
        const usage = (obj.usage ?? {}) as Record<string, number>;
        const isError = Boolean(obj.is_error);
        this.emit({
          ...base,
          kind: 'turn_end',
          isError,
          stopReason: (obj.stop_reason as string) ?? null,
          resultText: typeof obj.result === 'string' ? obj.result : null,
          error: isError && typeof obj.result === 'string' ? obj.result : null,
          durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : null,
          usage: {
            model: resolveModel(this.spec.brain, this.spec.modelTier),
            inputTokens: Number(usage.input_tokens ?? 0),
            outputTokens: Number(usage.output_tokens ?? 0),
            cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
            cacheCreationTokens: Number(usage.cache_creation_input_tokens ?? 0),
            costUsd: Number(obj.total_cost_usd ?? 0),
          },
        });
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
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* already gone */
      }
    }
    this.finish();
  }
}

export class CursorRunner implements Runner {
  readonly cli = 'cursor-agent';
  readonly capabilities = CAPABILITIES;

  async launch(spec: LaunchSpec): Promise<RunnerSession> {
    const bin = await resolveExecutor('cursor-agent');
    if (!bin) throw new Error('cursor-agent not found on this machine');

    const session = new CursorSession(spec.sessionId, spec, bin);
    if (spec.prompt) await session.send(spec.prompt);
    return session;
  }

  /**
   * Cursor stores chats under ~/.cursor/chats, but the on-disk layout has not
   * been verified against a chat id. Reported as not resumable so a swap takes
   * the rehydration path, which always works, rather than a native resume that
   * might silently attach to the wrong conversation.
   */
  async canResume(): Promise<boolean> {
    return false;
  }
}
