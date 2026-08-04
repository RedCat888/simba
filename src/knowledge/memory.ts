import { query, one, recordEvent } from '../db/index.js';

/**
 * Bounded, editable memory — what an agent knows without being asked.
 *
 * Distinct from the 30,000-vector recall store, and the distinction is the whole
 * point. Recall answers "have I seen this before" when something thinks to
 * search. Memory is present on every turn without anyone searching, which is the
 * only way a fact like "there is no `simba` Postgres role" actually prevents the
 * mistake — an agent that would have to look that up will simply not look.
 *
 * Bounded on purpose, and enforced by a database trigger rather than by this
 * module, because a limit that lives only in application code is a limit the
 * next writer ignores. When it is full, adding requires removing: that forced
 * choice is what stops it silently becoming a second vector store nobody reads.
 */

export type MemoryKind = 'environment' | 'preference' | 'convention' | 'person';

export interface MemoryRow {
  id: string;
  kind: MemoryKind;
  content: string;
  source: string | null;
  confirmations: number;
  agent_id: string | null;
}

const HEADINGS: Record<MemoryKind, string> = {
  environment: 'About this machine',
  convention: 'Rules that always apply',
  person: 'About the operator',
  preference: 'Preferences',
};

/**
 * The memory section of a hydration brief.
 *
 * Global memories plus this agent's own. Grouped by kind because an
 * undifferentiated list of facts reads as noise, and ordered so the rules that
 * always apply are not buried under machine trivia.
 */
export async function buildMemorySection(agentId: string): Promise<string | null> {
  const rows = await query<MemoryRow>(
    `SELECT id, kind, content, source, confirmations, agent_id
       FROM agent_memory
      WHERE agent_id IS NULL OR agent_id = $1
      ORDER BY
        CASE kind
          WHEN 'convention' THEN 0
          WHEN 'person' THEN 1
          WHEN 'environment' THEN 2
          ELSE 3
        END,
        confirmations DESC,
        learned_at`,
    [agentId],
  );
  if (rows.length === 0) return null;

  const byKind = new Map<MemoryKind, string[]>();
  for (const r of rows) {
    const list = byKind.get(r.kind) ?? [];
    list.push(r.content);
    byKind.set(r.kind, list);
  }

  const parts: string[] = [];
  for (const [kind, items] of byKind) {
    parts.push(`**${HEADINGS[kind]}**`);
    for (const item of items) parts.push(`- ${item}`);
    parts.push('');
  }

  parts.push(
    `This is your memory: ${rows.length} entries, deliberately capped. Add with ` +
      `\`memory_add\` when you learn something that would otherwise have to be ` +
      `rediscovered, and remove with \`memory_remove\` when something is wrong or ` +
      `no longer true. When it is full you must remove something to add something — ` +
      `choose, rather than letting it fill with trivia. A durable fact about the ` +
      `machine, the accounts, or how the operator wants things done belongs here; a ` +
      `procedure with steps belongs in a skill.`,
  );

  return parts.join('\n');
}

export async function addMemory(input: {
  kind: MemoryKind;
  content: string;
  source?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const content = input.content.trim();
  if (content.length < 4) return { ok: false, error: 'too short to be a fact' };
  if (content.length > 400) {
    return {
      ok: false,
      // The length limit is doing real work: this is loaded every turn, and a
      // paragraph here is a procedure that belongs in a skill.
      error: 'too long — memory holds single facts; anything with steps belongs in a skill',
    };
  }

  try {
    await query(
      `INSERT INTO agent_memory (agent_id, kind, content, source, created_by_session)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (agent_id, content) DO UPDATE
         SET confirmations = agent_memory.confirmations + 1,
             confirmed_at = now(),
             updated_at = now()`,
      [input.agentId ?? null, input.kind, content, input.source ?? null, input.sessionId ?? null],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The cap surfaces as a check violation carrying its own explanation, which
    // is more useful to the agent than anything this layer would invent.
    return { ok: false, error: message.replace(/^error:\s*/i, '').slice(0, 300) };
  }

  await recordEvent({
    type: 'memory.added',
    severity: 'debug',
    sessionId: input.sessionId ?? undefined,
    message: `remembered: ${content.slice(0, 120)}`,
    data: { kind: input.kind },
  });
  return { ok: true };
}

/** Removal is by content match, because that is what an agent can see. */
export async function removeMemory(
  match: string,
  agentId?: string | null,
): Promise<{ removed: number; content: string | null }> {
  const row = await one<{ id: string; content: string }>(
    `SELECT id, content FROM agent_memory
      WHERE (agent_id IS NULL OR agent_id = $2)
        AND content ILIKE '%' || $1 || '%'
      ORDER BY length(content)
      LIMIT 1`,
    [match, agentId ?? null],
  );
  if (!row) return { removed: 0, content: null };

  await query(`DELETE FROM agent_memory WHERE id = $1`, [row.id]);
  await recordEvent({
    type: 'memory.removed',
    severity: 'debug',
    message: `forgot: ${row.content.slice(0, 120)}`,
  });
  return { removed: 1, content: row.content };
}

export async function listMemory(agentId?: string | null): Promise<MemoryRow[]> {
  return query<MemoryRow>(
    `SELECT id, kind, content, source, confirmations, agent_id
       FROM agent_memory
      WHERE agent_id IS NULL OR agent_id = $1
      ORDER BY kind, learned_at`,
    [agentId ?? null],
  );
}

/** How full it is, so the agent can see the pressure before it hits the wall. */
export async function memoryPressure(agentId?: string | null): Promise<{
  global: { used: number; cap: number };
  own: { used: number; cap: number };
}> {
  const g = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_memory WHERE agent_id IS NULL`,
  );
  const o = agentId
    ? await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM agent_memory WHERE agent_id = $1`,
        [agentId],
      )
    : { n: 0 };
  return { global: { used: g?.n ?? 0, cap: 40 }, own: { used: o?.n ?? 0, cap: 20 } };
}
