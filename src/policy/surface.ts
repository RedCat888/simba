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

/**
 * Short TTL, deliberately.
 *
 * The cache previously never expired and nothing ever invalidated it, so
 * `UPDATE surfaces SET enabled = false` — the natural response to a lost phone
 * — had no effect until the gateway was restarted. That made the fastest
 * incident-response lever silently useless. Thirty seconds keeps the read cheap
 * while bounding how long a revocation takes to bite.
 */
const CACHE_TTL_MS = 30_000;

const cache = new Map<string, { row: Surface; at: number }>();

export async function getSurface(slug: string): Promise<Surface | null> {
  const cached = cache.get(slug);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.row;

  const row = await one<Surface>(`SELECT * FROM surfaces WHERE slug = $1`, [slug]);
  if (row) cache.set(slug, { row, at: Date.now() });
  else cache.delete(slug);
  return row;
}

/** The same lookup by id, for callers holding a session's origin_surface_id. */
export async function getSurfaceById(id: string): Promise<Surface | null> {
  const rows = await query<Surface>(`SELECT * FROM surfaces WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export function invalidateSurfaceCache(): void {
  cache.clear();
}

// resolveSurface lived here and has been removed.
//
// It decided authority from the *presence* of `cf-*` headers, which any local
// process could set, and it never verified the Access JWT. Worse, cloudflared
// dials loopback from this same host, so its loopback test distinguished
// nothing: local and tunnel traffic were indistinguishable to it.
//
// Replaced by src/policy/identity.ts, which roots the decision in which local
// port a connection landed on (not client-settable) and then proves identity
// with a verified signature. The `X-Simba-Surface` header is gone too: its
// "downgrade only" guarantee was unsound, because trust_level is a scalar while
// allowed_action_classes is an array, so a lower-trust surface can hold a
// capability a higher one lacks.

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

  // 'pending' counts. A session row is inserted as pending the moment a launch
  // begins and only becomes running once the CLI reports back, so excluding it
  // left a window where a started-but-not-yet-running session was invisible to
  // the ceiling — and two simultaneous starts could each see spare capacity.
  //
  // This narrows the race rather than closing it: the count and the insert are
  // still two statements. claimSessionSlot() below is the atomic version, used
  // on the path that actually creates the row. This remains the cheap
  // pre-flight check, so a caller gets a clear refusal instead of a constraint
  // violation.
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM sessions
      WHERE origin_surface_id = $1 AND status IN ('running','idle','pending')`,
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

/**
 * Claim a concurrency slot and create the session row in one statement.
 *
 * The pre-flight check above is check-then-act: two starts arriving together
 * both count, both see room, and both proceed. On a phone limited to one
 * session that is the difference between the limit meaning something and not.
 *
 * `INSERT … SELECT … WHERE (SELECT count(*) …) < limit` evaluates the count
 * inside the same statement that writes the row, so Postgres serialises them.
 * Returns null when the slot was not available, which the caller reports rather
 * than treating as an error — being at capacity is a normal outcome.
 */
export async function claimSessionSlot(
  surface: Surface,
  row: {
    sessionId: string;
    agentId: string;
    cli: string;
    brainId: string;
    nodeId: string | null;
    projectId: string | null;
    cwd: string;
    continuingSessionId: string | null;
    swapCount: number;
  },
): Promise<boolean> {
  const inserted = await query<{ id: string }>(
    `INSERT INTO sessions
       (id, agent_id, cli, brain_account_id, node_id, project_id, cwd, status,
        hydrated_from_session_id, swap_count, origin_surface_id, started_at, last_activity_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, now(), now()
      WHERE (
        SELECT count(*) FROM sessions s
         WHERE s.origin_surface_id = $10
           AND s.status IN ('running','idle','pending')
      ) < $11
     RETURNING id`,
    [
      row.sessionId,
      row.agentId,
      row.cli,
      row.brainId,
      row.nodeId,
      row.projectId,
      row.cwd,
      row.continuingSessionId,
      row.swapCount,
      surface.id,
      surface.max_concurrent_sessions,
    ],
  );
  return inserted.length > 0;
}
