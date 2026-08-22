import { query, one } from './index.js';
import { mergeBrainChains } from '../policy/brains.js';
import type { BrainAccount, ModelTier } from '../runner/types.js';

/** Typed accessors over the roster tables. Everything here is data, not code. */

export interface AgentRow {
  id: string;
  slug: string;
  name: string;
  tier: number;
  domain: string | null;
  description: string | null;
  project_id: string | null;
  node_id: string | null;
  preferred_cli: string | null;
  model_tier: ModelTier;
  brain_chain: string[];
  permission_profile_id: string | null;
  status: string;
  standing_brief: string | null;
  config: Record<string, unknown>;
  last_active_at: Date | null;
}

export interface BrainRow {
  id: string;
  slug: string;
  label: string;
  provider: string;
  kind: string;
  cli: string;
  config_dir: string | null;
  env: Record<string, string>;
  tier_models: Partial<Record<ModelTier, string>>;
  priority: number;
  enabled: boolean;
  status: string;
  limit_resets_at: Date | null;
}

export interface SessionRow {
  id: string;
  agent_id: string;
  native_session_id: string | null;
  cli: string;
  brain_account_id: string | null;
  project_id: string | null;
  worktree_path: string | null;
  branch: string | null;
  cwd: string | null;
  status: string;
  hydrated_from_session_id: string | null;
  swap_count: number;
  title: string | null;
  total_cost_usd: number;
  last_activity_at: Date | null;
  created_at: Date;
}

export function toBrainAccount(row: BrainRow): BrainAccount {
  return {
    id: row.id,
    slug: row.slug,
    provider: row.provider,
    cli: row.cli,
    configDir: row.config_dir,
    env: row.env ?? {},
    tierModels: row.tier_models ?? {},
  };
}

export async function getAgent(idOrSlug: string): Promise<AgentRow | null> {
  return one<AgentRow>(
    `SELECT * FROM agents WHERE (id::text = $1 OR slug = $1) AND retired_at IS NULL`,
    [idOrSlug],
  );
}

export async function listAgents(): Promise<AgentRow[]> {
  return query<AgentRow>(
    `SELECT * FROM agents WHERE retired_at IS NULL ORDER BY tier, slug`,
  );
}

export async function getBrain(idOrSlug: string): Promise<BrainRow | null> {
  return one<BrainRow>(
    `SELECT * FROM brain_accounts WHERE id::text = $1 OR slug = $1`,
    [idOrSlug],
  );
}

export async function listBrains(): Promise<BrainRow[]> {
  return query<BrainRow>(`SELECT * FROM brain_accounts ORDER BY priority`);
}

/**
 * The ordered fallback chain for an agent.
 *
 * Preference is `agents.brain_chain`, then rungs from the matching routing
 * policy that the agent row omitted. Only enabled brains that are not currently
 * limited or logged out are returned, so an exhausted account disappears until
 * its reset time passes — and Cursor still remains reachable after both Claudes.
 */
export async function resolveBrainChain(
  agent: AgentRow,
  availableClis?: string[],
): Promise<BrainRow[]> {
  const policy = await one<{ brain_chain: string[] }>(
    `SELECT brain_chain FROM routing_policies
      WHERE enabled
        AND (applies_to_agent_id = $1 OR (applies_to_agent_id IS NULL AND applies_to_tier = $2))
      ORDER BY (applies_to_agent_id IS NOT NULL) DESC, priority
      LIMIT 1`,
    [agent.id, agent.tier],
  );

  // Agent chain is preference, not a cage. Rungs the policy lists that the
  // agent row omitted still have to be reachable or failover stops at Claude.
  const ids = mergeBrainChains(agent.brain_chain ?? [], policy?.brain_chain ?? []);

  const clis = availableClis ?? null;

  if (ids.length === 0) {
    return query<BrainRow>(
      `SELECT * FROM brain_accounts
        WHERE enabled
          AND status IN ('available','unverified')
          AND ($1::text[] IS NULL OR cli = ANY($1::text[]))
        ORDER BY priority`,
      [clis],
    );
  }

  // Note on limit_resets_at: it is recorded on every rate-limit event, not only
  // on exhaustion — a healthy account still reports when its rolling window
  // rolls over. It is therefore only a gate when the account is actually
  // 'limited'; treating it as one unconditionally benches every working brain.
  const rows = await query<BrainRow>(
    `SELECT * FROM brain_accounts
      WHERE id = ANY($1::uuid[])
        AND enabled
        AND status NOT IN ('logged_out','error')
        AND (status <> 'limited' OR limit_resets_at IS NULL OR limit_resets_at <= now())
        AND ($2::text[] IS NULL OR cli = ANY($2::text[]))`,
    [ids, clis],
  );

  // Preserve the declared chain order rather than the database's.
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
}

/** Earliest moment any brain in the chain becomes usable again. */
export async function nextChainResetAt(agent: AgentRow): Promise<Date | null> {
  const policy = await one<{ brain_chain: string[] }>(
    `SELECT brain_chain FROM routing_policies
      WHERE enabled
        AND (applies_to_agent_id = $1 OR (applies_to_agent_id IS NULL AND applies_to_tier = $2))
      ORDER BY (applies_to_agent_id IS NOT NULL) DESC, priority
      LIMIT 1`,
    [agent.id, agent.tier],
  );
  const ids = mergeBrainChains(agent.brain_chain ?? [], policy?.brain_chain ?? []);
  const row = await one<{ next_reset: Date | null }>(
    `SELECT min(limit_resets_at) AS next_reset
       FROM brain_accounts
      WHERE enabled
        AND status = 'limited'
        AND limit_resets_at IS NOT NULL
        AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))`,
    [ids.length ? ids : null],
  );
  return row?.next_reset ?? null;
}

export async function markBrainLimited(
  brainId: string,
  resetsAt: Date | null,
  status = 'limited',
  error?: string | null,
): Promise<void> {
  await query(
    `UPDATE brain_accounts
        SET status = $2, limit_resets_at = $3, last_checked_at = now(), updated_at = now(),
            last_error = COALESCE($4, last_error)
      WHERE id = $1`,
    [brainId, status, resetsAt, error ?? null],
  );
}

export async function markBrainStatus(
  brainId: string,
  status: string,
  error?: string | null,
): Promise<void> {
  await query(
    `UPDATE brain_accounts
        SET status = $2, last_error = $3, last_checked_at = now(), updated_at = now()
      WHERE id = $1`,
    [brainId, status, error ?? null],
  );
}

export async function getSession(id: string): Promise<SessionRow | null> {
  return one<SessionRow>(`SELECT * FROM sessions WHERE id = $1`, [id]);
}

export async function listActiveSessions(): Promise<SessionRow[]> {
  return query<SessionRow>(
    `SELECT * FROM sessions
      WHERE status IN ('pending','running','idle','waiting_limit','sleeping')
      ORDER BY last_activity_at DESC NULLS LAST`,
  );
}

export async function listAgentSessions(agentId: string, limit = 50): Promise<SessionRow[]> {
  return query<SessionRow>(
    `SELECT * FROM sessions WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [agentId, limit],
  );
}

export async function setSessionStatus(
  id: string,
  status: string,
  error?: string | null,
): Promise<void> {
  await query(
    `UPDATE sessions
        SET status = $2,
            error = COALESCE($3, error),
            ended_at = CASE WHEN $2 IN ('completed','failed','killed','superseded')
                            THEN now() ELSE ended_at END
      WHERE id = $1`,
    [id, status, error ?? null],
  );
}

export async function getPermissionProfile(
  id: string | null,
): Promise<{ deny_patterns: string[]; confirm_patterns: string[] } | null> {
  if (!id) return null;
  return one(`SELECT deny_patterns, confirm_patterns FROM permission_profiles WHERE id = $1`, [id]);
}
