/**
 * Brain failover signals.
 *
 * These live outside the runners so a session that dies with "OAuth expired"
 * is classified the same way whether the string arrived on stderr, in a JSON
 * result, or as a process exit message. The previous regex only matched
 * "not logged in" / "/login" / "unauthor", so an expired OAuth token looked
 * like a normal crash and the chain never advanced.
 */

export const FAILOVER_CONTINUE_PROMPT =
  'The previous brain hit a usage limit, logged out, or died. ' +
  'You are the continuation of the same job, not a new conversation. ' +
  'Do not wait for the user. Read your brief and the working tree, then continue immediately. ' +
  'If you were mid-task, pick it up. If you were waiting for the user, say so in one sentence and keep going on anything still unfinished.';

/** Paid subscriptions that must be probed before falling through to local/free CLIs. */
export const PAID_BRAIN_SLUGS = ['claude-b', 'claude-a', 'cursor', 'codex'] as const;

/** Last-resort local CLIs. Using one of these without re-checking paid brains is the failure mode. */
export const FLOOR_BRAIN_SLUGS = ['opencode', 'ollama'] as const;

export function isFloorBrainSlug(slug: string): boolean {
  return (FLOOR_BRAIN_SLUGS as readonly string[]).includes(slug);
}

export function isPaidBrainSlug(slug: string): boolean {
  return (PAID_BRAIN_SLUGS as readonly string[]).includes(slug);
}

/**
 * Login is gone and will not come back on its own. Distinct from a 403 that
 * arrived with a usage-limit message — Cursor's team cap looks like HTTP 403
 * and is a quota, not a logout.
 */
export function isHardAuthFailure(text: string): boolean {
  return /not logged in|please run\s*\/login|oauth|token expired|authentication[_\s-]?error|\b401\b|logged out|not authenticated|invalid.?api.?key|no credentials/i.test(
    text,
  );
}

export function isAuthFailureMessage(text: string): boolean {
  return (
    isHardAuthFailure(text) ||
    /unauthor|forbidden|not licensed|\b403\b|no models available/i.test(text)
  );
}

export function isRateLimitedMessage(text: string): boolean {
  return /rate limit|quota|usage limit|\b429\b|on-demand usage|out of usage|usage.{0,40}exhaust|five-hour|5-hour limit/i.test(
    text,
  );
}

/**
 * Pull a reset time out of a CLI's refusal.
 *
 * Cursor prints "return on 8/22/2026". Claude prints an ISO timestamp on the
 * five-hour window. Without this, verify recorded every limit as "one hour from
 * now", so a team cap that lasts until Saturday looked like it would clear
 * after lunch.
 */
export function parseUsageResetAt(text: string): Date | null {
  if (!text) return null;

  const iso = text.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
  if (iso) {
    const d = new Date(iso[1]!);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const labeled = text.match(
    /(?:return on|come back(?:\s+on)?|until|resets?(?:\s+on)?)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i,
  );
  const bare = labeled ?? text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (bare) {
    const month = Number(bare[1]);
    const day = Number(bare[2]);
    const year = Number(bare[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2020) {
      const d = new Date(Date.UTC(year, month - 1, day));
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  return null;
}

/**
 * Agent-specific order first, then any brains the routing policy lists that
 * the agent chain omitted.
 *
 * An explicit `agents.brain_chain` used to *replace* the policy. Simba's seed
 * chain was claude-a → claude-b → codex, so Cursor — which the tier-0 policy
 * had added later — was unreachable through failover. Appending the missing
 * rungs is what makes "the chain" actually the chain.
 */
export function mergeBrainChains(preferred: string[], fallback: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...preferred, ...fallback]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Next brain after the one that just failed. Skips the current id even if it
 * is still listed as available — that is how an unclassified crash still
 * advances instead of retrying the same dead account forever.
 */
export function nextBrainInChain<T extends { id: string }>(
  chain: T[],
  currentId: string,
): T | undefined {
  return chain.find((b) => b.id !== currentId);
}
