import { one, query, recordEvent } from '../db/index.js';
import type { ModelTier } from '../runner/types.js';

/**
 * Surface policy: authority scoped by origin.
 *
 * Effective authority is the intersection of the agent's permission profile and
 * the originating surface's policy. Neither widens the other — a highly trusted
 * agent reached from the phone is still bounded by the phone's limits, and a
 * restricted agent does not gain anything by being addressed from the desktop.
 */

export interface Surface {
  id: string;
  slug: string;
  name: string;
  trust_level: number;
  allowed_action_classes: string[];
  confirm_action_classes: string[];
  max_model_tier: ModelTier;
  can_spawn_agents: boolean;
  can_modify_roster: boolean;
  can_panic: boolean;
  allowed_agent_slugs: string[] | null;
  denied_agent_slugs: string[];
  max_concurrent_sessions: number;
  enabled: boolean;
}

const TIER_RANK: Record<ModelTier, number> = { free: 0, cheap: 1, mid: 2, high: 3 };

const cache = new Map<string, Surface>();

export async function getSurface(slug: string): Promise<Surface | null> {
  const cached = cache.get(slug);
  if (cached) return cached;
  const row = await one<Surface>(`SELECT * FROM surfaces WHERE slug = $1`, [slug]);
  if (row) cache.set(slug, row);
  return row;
}

export function invalidateSurfaceCache(): void {
  cache.clear();
}

/**
 * Determines which surface a request originated from.
 *
 * Loopback is treated as the desktop because reaching it already requires
 * either physical access or code running on the machine — both of which imply
 * more authority than any header could grant. Anything arriving through the
 * tunnel carries Cloudflare Access headers and is treated as the phone.
 *
 * An explicit header can only ever *narrow* the result. Letting a caller name
 * its own surface upward would make the whole mechanism decorative, since the
 * untrusted side controls its own headers.
 */
export async function resolveSurface(
  headers: Record<string, string | undefined>,
  remoteAddress: string | undefined,
): Promise<Surface | null> {
  const accessUser =
    headers['cf-access-authenticated-user-email'] ?? headers['cf-access-jwt-assertion'];
  const viaTunnel = Boolean(accessUser || headers['cf-connecting-ip'] || headers['cf-ray']);

  const isLoopback =
    !remoteAddress ||
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1';

  let slug = viaTunnel ? 'phone' : isLoopback ? 'desktop' : 'automation';

  // A request may declare itself less trusted than it looks, never more.
  const declared = headers['x-simba-surface'];
  if (declared) {
    const [claimed, current] = await Promise.all([getSurface(declared), getSurface(slug)]);
    if (claimed && current && claimed.trust_level <= current.trust_level) {
      slug = claimed.slug;
    }
  }

  return getSurface(slug);
}

export interface Decision {
  allowed: boolean;
  reason?: string;
  /** Allowed, but the effect must be confirmed by the operator before it runs. */
  needsConfirmation?: boolean;
}

export async function canReachAgent(surface: Surface, agentSlug: string): Promise<Decision> {
  if (!surface.enabled) {
    return { allowed: false, reason: `surface "${surface.slug}" is disabled` };
  }
  if (surface.denied_agent_slugs?.includes(agentSlug)) {
    return { allowed: false, reason: `"${agentSlug}" is not reachable from ${surface.slug}` };
  }
  if (surface.allowed_agent_slugs && !surface.allowed_agent_slugs.includes(agentSlug)) {
    return { allowed: false, reason: `"${agentSlug}" is not in ${surface.slug}'s allow-list` };
  }

  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM sessions
      WHERE origin_surface_id = $1 AND status IN ('running','idle')`,
    [surface.id],
  );
  const n = rows[0]?.n ?? 0;
  if (n >= surface.max_concurrent_sessions) {
    return {
      allowed: false,
      reason: `${surface.slug} already has ${n} live sessions (limit ${surface.max_concurrent_sessions})`,
    };
  }

  return { allowed: true };
}

/** Clamps a requested tier to what the surface permits. */
export function clampModelTier(surface: Surface, requested: ModelTier): ModelTier {
  const max = surface.max_model_tier;
  return TIER_RANK[requested] > TIER_RANK[max] ? max : requested;
}

/**
 * Whether an irreversible external effect may proceed from this surface.
 * Returns needsConfirmation rather than a hard refusal where the surface allows
 * the class but wants a human in the loop.
 */
export async function checkAction(
  surface: Surface | null,
  actionClass: string,
): Promise<Decision> {
  // Absent a known surface, refuse rather than assume the trusted default —
  // an unrecognised origin is the case most worth being strict about.
  if (!surface) return { allowed: false, reason: 'unknown origin surface' };
  if (!surface.enabled) return { allowed: false, reason: `surface "${surface.slug}" is disabled` };

  if (surface.confirm_action_classes?.includes(actionClass)) {
    return { allowed: true, needsConfirmation: true };
  }
  if (!surface.allowed_action_classes?.includes(actionClass)) {
    return {
      allowed: false,
      reason: `"${actionClass}" actions cannot originate from ${surface.slug}`,
    };
  }
  return { allowed: true };
}

export async function logDenial(
  surface: Surface | null,
  what: string,
  reason: string,
): Promise<void> {
  await recordEvent({
    type: 'surface.denied',
    severity: 'warn',
    message: `${surface?.slug ?? 'unknown'} denied ${what}: ${reason}`,
    data: { surface: surface?.slug ?? null, what, reason },
  });
}
