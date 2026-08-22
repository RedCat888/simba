import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { config } from '../config.js';
import { opencodeComplete } from './opencode.js';
import { openAICompatComplete, openAICompatConfigured } from './openai-compat.js';

const execFileAsync = promisify(execFile);

/**
 * Cheap completions for the boring work: session titling, summarization,
 * checkpoint authoring, intent classification.
 *
 * None of this deserves a high-tier brain, and burning Opus headroom on
 * secretarial tasks is precisely what makes a $20 plan run out. Order of
 * preference is local-and-free first, then the cheapest subscription tier.
 */

const CLAUDE_BIN =
  process.env.SIMBA_CLAUDE_BIN ?? join(homedir(), '.local', 'bin', 'claude.exe');

export interface CheapOptions {
  /** Config dir of the brain account to charge, when falling back to a CLI. */
  configDir?: string | null;
  maxChars?: number;
  timeoutMs?: number;
  /**
   * Skip the local model and go straight to the cheapest hosted tier.
   *
   * Local models are the right default for bulk summarization, where being
   * roughly right is enough. They are measurably worse at judgement calls that
   * need instructions followed precisely — asked to extract decisions and told
   * not to include facts, a 14b quant returns facts anyway. When the output is
   * permanent and the volume is bounded, that trade goes the other way.
   */
  preferQuality?: boolean;
  /**
   * Skip the free remote tier.
   *
   * Measured: OpenCode's free tier answers reliably (5/5) but averages ~30s per
   * call, most of it CLI start-up. That is fine for background work — titling,
   * summarising, bulk extraction — and unacceptable on a path that runs every
   * turn, where it would add half a minute to each one. Callers on the hot path
   * set this.
   */
  preferSpeed?: boolean;
}

/** Local Ollama. Free, no subscription consumed, good enough for summaries. */
async function ollamaComplete(prompt: string, timeoutMs: number): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${config.embedding.endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // Must name a model actually present locally — `ollama list` is the
        // source of truth. A missing model fails the request, which silently
        // pushes every cheap call onto the Claude fallback and quietly spends
        // subscription headroom on summarization.
        model: process.env.SIMBA_CHEAP_MODEL ?? 'qwen2.5-coder:14b-instruct-q3_K_S',
        prompt,
        stream: false,
        options: { temperature: 0.2 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as { response?: string };
    const text = body.response?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Windows caps a command line at about 32,767 characters, and a prompt is not a
 * small argument.
 *
 * Checkpoints were failing with `spawn ENAMETOOLONG` for exactly the sessions
 * that most needed one: a long transcript makes a long prompt, the spawn is
 * refused before the model is ever reached, and the caller sees null - which is
 * indistinguishable from "the model had nothing to say". 17 of 79 checkpoints in
 * this database are blank, and on 19 August ten of eleven were.
 *
 * So the prompt goes down stdin, which `claude -p` reads when given no prompt
 * argument, and the limit stops applying at all.
 */
function runWithStdin(
  bin: string,
  args: string[],
  input: string,
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { env: opts.env, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
    proc.stderr.on('data', (c: Buffer) => (err += c.toString()));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`exit ${code}: ${err.slice(0, 300)}`));
    });

    proc.stdin.on('error', () => {
      /* the child may close stdin early; the close handler reports the outcome */
    });
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

/** Cheapest subscription tier. Used only when Ollama is unavailable. */
async function claudeCheapComplete(
  prompt: string,
  configDir: string | null | undefined,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const env = { ...process.env };
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir;

    const stdout = await runWithStdin(
      CLAUDE_BIN,
      [
        // No prompt argument: it goes down stdin instead, so the length of a
        // transcript stops being able to refuse the spawn.
        '-p',
        '--model', 'haiku',
        '--output-format', 'json',
        '--permission-mode', 'bypassPermissions',
        // No `--tools ''`. An empty string is dropped by the argument parser,
        // so the flag then reports "argument missing" and the whole call fails
        // — silently, because the caller only sees null.
        //
        // --strict-mcp-config with no --mcp-config suppresses every ambient MCP
        // server. Without it this loads the full claude.ai connector set and
        // pays ~8k cache-creation tokens per call, on what is supposed to be
        // the cheap path.
        '--strict-mcp-config',
      ],
      prompt,
      { env, timeoutMs },
    );
    // `--output-format json` emits an ARRAY of stream events, not a single
    // result object. Reading `.result` off the array yielded undefined, so this
    // returned null on every successful call — and because null is
    // indistinguishable from "the model found nothing" at the call site, the
    // whole hosted path looked like it was working and returning empty.
    // Both shapes are accepted so a future format change degrades rather than
    // silently zeroes out.
    const parsed = JSON.parse(stdout) as unknown;
    const result = Array.isArray(parsed)
      ? (parsed as Array<Record<string, unknown>>).find((e) => e.type === 'result')
      : (parsed as Record<string, unknown>);

    if (!result) {
      console.error('[cheap] no result event in hosted response');
      return null;
    }
    if (result.is_error) {
      console.error('[cheap] hosted call reported an error:', String(result.result).slice(0, 200));
      return null;
    }
    const text = typeof result.result === 'string' ? result.result.trim() : '';
    return text.length > 0 ? text : null;
  } catch (err) {
    // Logged rather than swallowed. A null here is indistinguishable from "the
    // model found nothing" at every call site, which is exactly how a broken
    // hosted-tier call passed for precise extraction across 32 items.
    console.error(
      '[cheap] hosted completion failed:',
      err instanceof Error ? err.message.slice(0, 200) : err,
    );
    return null;
  }
}

export async function cheapComplete(
  prompt: string,
  opts: CheapOptions = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const maxChars = opts.maxChars ?? 60_000;
  const trimmed = prompt.length > maxChars ? prompt.slice(0, maxChars) + '\n…[truncated]' : prompt;

  // Free tiers first, then the cheapest subscription tier.
  //
  // Ordering is deliberate. Ollama is free and private but slow (~16 tok/s on
  // this GPU) and competes for RAM with Postgres and the agent processes.
  // OpenCode's free tier is remote, faster, and costs nothing — so it is
  // preferred for bulk work, with local as the offline fallback. Only when both
  // are unavailable, or the caller explicitly wants better instruction
  // following, does this reach a paid subscription.
  if (!opts.preferQuality) {
    // A configured OpenAI-compatible endpoint goes first: if the user has
    // deliberately pointed Simba at one, that is a stronger signal than any
    // default here. Inert when unset.
    if (openAICompatConfigured()) {
      const routed = await openAICompatComplete(trimmed, timeoutMs);
      if (routed) return routed;
    }

    if (!opts.preferSpeed) {
      const free = await opencodeComplete(trimmed, timeoutMs);
      if (free) return free;
    }

    const local = await ollamaComplete(trimmed, timeoutMs);
    if (local) return local;
  }

  return claudeCheapComplete(trimmed, opts.configDir, timeoutMs);
}

/** True when a local model is reachable, so callers can prefer free paths. */
export async function ollamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${config.embedding.endpoint}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
