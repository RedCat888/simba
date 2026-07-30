import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { config } from '../config.js';

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

/** Cheapest subscription tier. Used only when Ollama is unavailable. */
async function claudeCheapComplete(
  prompt: string,
  configDir: string | null | undefined,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const env = { ...process.env };
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir;

    const { stdout } = await execFileAsync(
      CLAUDE_BIN,
      ['-p', prompt, '--model', 'haiku', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--tools', ''],
      { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    );
    const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
    if (parsed.is_error) return null;
    return parsed.result?.trim() ?? null;
  } catch {
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

  const local = await ollamaComplete(trimmed, timeoutMs);
  if (local) return local;

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
