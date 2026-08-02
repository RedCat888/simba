import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';

import { AsyncQueue } from './queue.js';
import { config } from '../config.js';
import type {
  BrainAccount,
  LaunchSpec,
  ModelTier,
  Runner,
  RunnerCapability,
  RunnerEvent,
  RunnerSession,
} from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Local-model runner: a real agent loop against Ollama's OpenAI-compatible
 * endpoint.
 *
 * Unlike the other runners this one has no CLI to drive, so the loop, the tool
 * definitions and the tool execution all live here. That is more code, but it
 * buys the thing the other three cannot: a brain that is structurally free,
 * cannot be rate-limited, and keeps working when every subscription is
 * exhausted. It is the floor the whole failover ladder rests on.
 *
 * Because the loop is ours, the permission deny-list is enforced directly in
 * the executor rather than through a PreToolUse hook.
 */

const CAPABILITIES: ReadonlySet<RunnerCapability> = new Set<RunnerCapability>([
  'stream',
  'steer',
  'interrupt',
]);

const MAX_ITERATIONS = 40;
const MAX_TOOL_OUTPUT = 24_000;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description:
        'Run a PowerShell command in the working directory and return its output. ' +
        'Use for builds, tests, git, and inspecting the system.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The PowerShell command' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file. Paths are relative to the working directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write a UTF-8 text file, creating parent directories as needed.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'List entries in a directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Defaults to the working directory' } },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search',
      description: 'Search file contents recursively for a regular expression.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'finish',
      description:
        'Call when the task is complete. Provide a summary of what was done. ' +
        'Always finish with this rather than trailing off.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    },
  },
];

function resolveModel(brain: BrainAccount, tier: ModelTier): string {
  return brain.tierModels[tier] ?? brain.tierModels.free ?? 'qwen2.5-coder:14b-instruct-q3_K_S';
}

class OllamaSession implements RunnerSession {
  readonly capabilities = CAPABILITIES;
  readonly nativeSessionId: string;

  private readonly queue = new AsyncQueue<RunnerEvent>();
  private readonly messages: ChatMessage[] = [];
  private readonly deny: RegExp[];
  private readonly pending: string[] = [];
  private running = false;
  private stopped = false;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(
    readonly sessionId: string,
    private readonly spec: LaunchSpec,
  ) {
    this.nativeSessionId = sessionId;
    this.deny = (spec.denyPatterns ?? [])
      .map((p) => {
        try {
          return new RegExp(p);
        } catch {
          return null;
        }
      })
      .filter((r): r is RegExp => r !== null);

    const brief = spec.systemPromptAppend ? `\n\n${spec.systemPromptAppend}` : '';
    this.messages.push({
      role: 'system',
      content:
        `You are a capable autonomous agent working in ${spec.cwd} on a Windows machine. ` +
        `Use the provided tools to accomplish the task. Work in small concrete steps and ` +
        `verify your work by running commands. When the task is done, call the finish tool ` +
        `with a summary. Do not ask the user questions — decide and proceed.${brief}`,
    });
  }

  get alive(): boolean {
    return !this.stopped;
  }

  events(): AsyncIterableIterator<RunnerEvent> {
    return this.queue.iterator();
  }

  private emit(e: RunnerEvent): void {
    this.queue.push(e);
  }

  private base() {
    return { sessionId: this.sessionId, raw: {}, at: new Date() };
  }

  async send(text: string): Promise<void> {
    if (this.stopped) throw new Error('session is closed');
    this.messages.push({ role: 'user', content: text });

    // Mid-run steering: the loop checks between iterations, so an incoming
    // message is picked up at the next tool boundary rather than being queued
    // until the whole task finishes.
    if (this.running) {
      this.pending.push(text);
      return;
    }
    void this.runLoop();
  }

  private async runLoop(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const startedAt = Date.now();
    const model = resolveModel(this.spec.brain, this.spec.modelTier);

    this.emit({
      ...this.base(),
      kind: 'init',
      nativeSessionId: this.sessionId,
      model,
      cwd: this.spec.cwd,
      permissionMode: 'bypass-with-denylist',
      apiKeySource: 'none',
      tools: TOOLS.map((t) => t.function.name),
    });

    try {
      for (let i = 0; i < MAX_ITERATIONS && !this.stopped; i++) {
        // Fold in anything the user said while a tool was running.
        while (this.pending.length > 0) {
          const steer = this.pending.shift()!;
          this.messages.push({
            role: 'user',
            content: `[steering] ${steer}`,
          });
        }

        const reply = await this.chat(model);
        if (!reply) break;

        this.messages.push(reply);

        // Local models are inconsistent about where tool calls land. Many emit
        // correctly-formed call objects as plain text in `content` instead of
        // populating `tool_calls` — the model is doing the right thing and the
        // chat template simply fails to capture it. Falling back to parsing the
        // content is what makes this runner work across quants rather than only
        // against whichever model happened to be tested.
        const structured = reply.tool_calls ?? [];
        const calls = structured.length > 0 ? structured : extractToolCalls(reply.content ?? '');
        const parsedFromText = structured.length === 0 && calls.length > 0;

        // Suppress the raw JSON as assistant prose when it was really a call.
        if (reply.content?.trim() && !parsedFromText) {
          this.emit({
            ...this.base(),
            kind: 'text',
            role: 'assistant',
            text: reply.content,
            partial: false,
          });
        }

        if (calls.length === 0) break; // no tools requested: the turn is over

        let finished = false;
        for (const call of calls) {
          if (call.function.name === 'finish') {
            finished = true;
            const args = safeParse(call.function.arguments);
            const summary = String(args.summary ?? 'done');
            this.emit({
              ...this.base(),
              kind: 'text',
              role: 'assistant',
              text: summary,
              partial: false,
            });
            break;
          }
          await this.executeTool(call);
        }
        if (finished) break;
      }
    } catch (err) {
      this.emit({
        ...this.base(),
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running = false;
      this.emit({
        ...this.base(),
        kind: 'turn_end',
        isError: false,
        stopReason: 'end_turn',
        resultText: null,
        error: null,
        // Recorded so local throughput shows up in the same place as every
        // other runner's, rather than having to be benchmarked separately.
        durationMs: Date.now() - startedAt,
        usage: {
          model,
          inputTokens: this.inputTokens,
          outputTokens: this.outputTokens,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          // Structurally zero: this brain runs on hardware already paid for.
          costUsd: 0,
        },
      });
      this.inputTokens = 0;
      this.outputTokens = 0;

      if (this.pending.length > 0) void this.runLoop();
    }
  }

  private async chat(model: string): Promise<ChatMessage | null> {
    const res = await fetch(`${config.embedding.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: this.messages,
        tools: TOOLS,
        temperature: 0.3,
        stream: false,
        // Cold load costs 8-15s and an agent loop makes many calls in a row, so
        // some residency is worth far more than raw tokens/sec. But a 14b model
        // pins several GB, and this machine is simultaneously running Postgres,
        // the gateway and one or more agent CLIs — holding it for 30m exhausted
        // the page file in testing. Five minutes spans a working loop while
        // still releasing memory between tasks.
        keep_alive: '5m',
      }),
      signal: AbortSignal.timeout(600_000),
    });

    if (!res.ok) {
      throw new Error(`ollama chat failed (${res.status}): ${await res.text().catch(() => '')}`);
    }

    const body = (await res.json()) as {
      choices?: Array<{ message?: ChatMessage }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    this.inputTokens += body.usage?.prompt_tokens ?? 0;
    this.outputTokens += body.usage?.completion_tokens ?? 0;

    return body.choices?.[0]?.message ?? null;
  }

  /** Deny-list check. This runner has no hook, so the gate lives here. */
  private blocked(text: string): boolean {
    return this.deny.some((re) => re.test(text));
  }

  private resolveInCwd(p: string): string {
    const abs = isAbsolute(p) ? p : resolve(this.spec.cwd, p);
    return abs;
  }

  private async executeTool(call: {
    id: string;
    function: { name: string; arguments: string };
  }): Promise<void> {
    const name = call.function.name;
    const args = safeParse(call.function.arguments);

    this.emit({ ...this.base(), kind: 'tool_call', toolUseId: call.id, name, args });

    let output = '';
    let isError = false;

    try {
      switch (name) {
        case 'run_command': {
          const command = String(args.command ?? '');
          if (this.blocked(command)) {
            output =
              'Blocked by Simba: this touches core disk, OS, boot or registry state. ' +
              'Report the block and continue with the rest of the task.';
            isError = true;
            break;
          }
          const { stdout, stderr } = await execFileAsync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', command],
            { cwd: this.spec.cwd, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
          );
          output = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim() || '(no output)';
          break;
        }

        case 'read_file': {
          const p = this.resolveInCwd(String(args.path ?? ''));
          output = existsSync(p) ? await readFile(p, 'utf8') : `File not found: ${args.path}`;
          isError = !existsSync(p);
          break;
        }

        case 'write_file': {
          const p = this.resolveInCwd(String(args.path ?? ''));
          if (this.blocked(p)) {
            output = 'Blocked by Simba: that path is protected.';
            isError = true;
            break;
          }
          await mkdir(dirname(p), { recursive: true });
          await writeFile(p, String(args.content ?? ''), 'utf8');
          output = `Wrote ${relative(this.spec.cwd, p) || p}`;
          break;
        }

        case 'list_files': {
          const p = this.resolveInCwd(String(args.path ?? '.'));
          const entries = await readdir(p, { withFileTypes: true });
          output = entries
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .slice(0, 400)
            .join('\n');
          break;
        }

        case 'search': {
          const p = this.resolveInCwd(String(args.path ?? '.'));
          const { stdout } = await execFileAsync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Get-ChildItem -Path '${p}' -Recurse -File -ErrorAction SilentlyContinue | ` +
                `Select-Object -First 4000 | ` +
                `Select-String -Pattern '${String(args.pattern ?? '').replace(/'/g, "''")}' -ErrorAction SilentlyContinue | ` +
                `Select-Object -First 60 | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }`,
            ],
            { cwd: this.spec.cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
          );
          output = stdout.trim() || '(no matches)';
          break;
        }

        default:
          output = `Unknown tool: ${name}`;
          isError = true;
      }
    } catch (err) {
      output = err instanceof Error ? err.message : String(err);
      isError = true;
    }

    if (output.length > MAX_TOOL_OUTPUT) {
      output = output.slice(0, MAX_TOOL_OUTPUT) + '\n…[truncated]';
    }

    this.emit({
      ...this.base(),
      kind: 'tool_result',
      toolUseId: call.id,
      result: { output },
      resultText: output,
      isError,
    });

    this.messages.push({ role: 'tool', tool_call_id: call.id, content: output });
  }

  async interrupt(): Promise<void> {
    this.stopped = true;
  }

  async kill(): Promise<void> {
    this.stopped = true;
    this.pending.length = 0;
    this.emit({ ...this.base(), kind: 'exit', code: 0, signal: null });
    this.queue.close();
  }
}

export class OllamaRunner implements Runner {
  readonly cli = 'ollama';
  readonly capabilities = CAPABILITIES;

  async launch(spec: LaunchSpec): Promise<RunnerSession> {
    const session = new OllamaSession(spec.sessionId, spec);
    if (spec.prompt) await session.send(spec.prompt);
    return session;
  }

  /**
   * Conversation state lives in Postgres and is replayed through the hydration
   * bundle, so there is no native session on disk to resume. Reported as not
   * resumable, which routes a continuation through rehydration — the correct
   * path for a runner with no durable native state.
   */
  async canResume(): Promise<boolean> {
    return false;
  }
}

/**
 * Recovers tool calls a model wrote into its message body.
 *
 * Scans for balanced top-level JSON objects rather than regex-matching, because
 * arguments routinely contain braces (file contents, code, nested objects) and
 * a non-greedy pattern truncates them at the first inner `}`.
 */
function extractToolCalls(content: string): Array<{
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}> {
  const out: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
  if (!content.includes('"name"')) return out;

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const slice = content.slice(start, i + 1);
        start = -1;
        try {
          const obj = JSON.parse(slice) as Record<string, unknown>;
          const name = obj.name ?? (obj.function as Record<string, unknown>)?.name;
          const args = obj.arguments ?? obj.parameters ??
            (obj.function as Record<string, unknown>)?.arguments;
          if (typeof name === 'string' && name) {
            out.push({
              id: `local_${out.length}_${Date.now()}`,
              type: 'function',
              function: {
                name,
                arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
              },
            });
          }
        } catch {
          // Not a tool call; ordinary prose that happened to contain braces.
        }
      }
    }
  }

  return out;
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** True when Ollama is reachable, so the chain can skip it when it is not. */
export async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${config.embedding.endpoint}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}
