import { config } from '../config.js';

/**
 * Generic OpenAI-compatible completion endpoint.
 *
 * This is what survived evaluating OmniRoute. That project aggregates ~278
 * providers and advertises ~1.5B free tokens a month, but every one of those
 * free tiers is reached with a per-provider API key you sign up for — it boots
 * a Next.js dashboard, a SQLite store and an auth layer, and until someone has
 * manually created accounts at forty providers it routes to nothing. The single
 * provider in its catalog reachable without a key is OpenCode Zen, which Simba
 * already calls directly. Running it would have been a second always-on server
 * that returns exactly what we already have.
 *
 * What was worth keeping is its interface: one OpenAI-shaped endpoint that any
 * number of backends can hide behind. So rather than adopt the gateway, Simba
 * speaks that protocol natively. Point SIMBA_OPENAI_BASE at anything — OmniRoute
 * later, LM Studio, llama.cpp, vLLM, or a free tier the user does sign up for —
 * and it joins the cheap chain with no further code. Unset, this is inert and
 * costs nothing, which is the honest default given the no-API-key rule.
 */

const BASE = process.env.SIMBA_OPENAI_BASE ?? '';
const KEY = process.env.SIMBA_OPENAI_KEY ?? '';
const MODEL = process.env.SIMBA_OPENAI_MODEL ?? 'gpt-4o-mini';

export function openAICompatConfigured(): boolean {
  return BASE.trim().length > 0;
}

export async function openAICompatComplete(
  prompt: string,
  timeoutMs = 60_000,
): Promise<string | null> {
  if (!openAICompatConfigured()) return null;

  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // Local servers generally accept an absent Authorization header; hosted ones
    // require it. Sending an empty bearer token is worse than sending none, so
    // the header only appears when there is actually a key.
    if (KEY) headers.authorization = `Bearer ${KEY}`;

    const res = await fetch(`${BASE.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: process.env.SIMBA_OPENAI_MODEL ?? MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      // Surfaced rather than swallowed. A misconfigured endpoint that silently
      // returns null is indistinguishable from one that is simply unset, and
      // that ambiguity is exactly how a broken cheap tier went unnoticed before.
      console.error(
        '[openai-compat]',
        res.status,
        (await res.text().catch(() => '')).slice(0, 200),
      );
      return null;
    }

    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch (err) {
    console.error(
      '[openai-compat] request failed:',
      err instanceof Error ? err.message.slice(0, 200) : err,
    );
    return null;
  }
}

/** Kept so callers can describe the configured backend without leaking the key. */
export function openAICompatDescribe(): string {
  if (!openAICompatConfigured()) return 'unconfigured';
  return `${BASE} (${MODEL})${KEY ? ' +key' : ''}`;
}

void config;
