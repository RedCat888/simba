import { query, one, recordEvent } from '../db/index.js';
import { cheapComplete } from '../hydration/cheap.js';

/**
 * Keeps the stores worth reading.
 *
 * Both memory and skills are load-bearing on every turn — measurement put
 * memory at 37% of Simba's brief and the skills index at 22% — and both grow
 * automatically now that sessions are harvested without being asked. A store
 * that only ever grows becomes a store nobody can afford to load, which is the
 * failure mode this exists to prevent.
 *
 * Taken from Hermes' Curator, with its central discipline kept: it tracks use,
 * archives what nothing reads, and consolidates near-duplicates. Where it
 * deliberately differs is in what it is allowed to destroy.
 *
 *   - Skills are **archived, never deleted**. `enabled = false` removes the
 *     index cost, which is the only cost that matters, while keeping the text
 *     recoverable. A procedure someone bothered to write is worth more than
 *     the row it occupies.
 *   - Memory *is* rewritten, because merging two overlapping facts into one
 *     accurate fact is the entire point of a bounded store. Every merge is
 *     logged with what it replaced.
 */

/** Consolidation starts before the cap, so an agent is never blocked mid-thought. */
const MEMORY_PRESSURE_THRESHOLD = 0.75;

const MERGE_PROMPT = `You are consolidating an agent's memory. It is nearly full and
entries overlap.

Return ONLY a JSON object:
{ "merges": [ { "replaces": ["exact text of entry 1", "exact text of entry 2"], "with": "one merged fact" } ] }

Rules, in order of importance:
- Never invent. Every claim in a merged fact must appear in the entries it replaces.
- Never merge facts that are merely about the same topic. "Postgres is on port 5432"
  and "the simba role does not exist" are both about Postgres and are different facts.
- Merge only genuine overlap: the same fact stated twice, or a fact and a narrower
  restatement of itself.
- A merged fact must be shorter than the entries it replaces, or the merge is pointless.
- Keep every specific: paths, ports, flags, names, exact error text.
- If nothing genuinely overlaps, return {"merges": []}. That is a correct answer.

Entries follow, one per line.
---
`;

export interface CurationResult {
  memoryMerged: number;
  skillsArchived: number;
  notes: string[];
}

/**
 * Merge overlapping memories when the store is under pressure.
 *
 * Runs only near the cap. Consolidating a half-empty store spends a model call
 * to solve a problem nobody has, and every merge is a small chance of losing a
 * distinction that mattered.
 */
async function curateMemory(): Promise<{ merged: number; notes: string[] }> {
  const notes: string[] = [];
  const rows = await query<{ content: string }>(
    `SELECT content FROM agent_memory WHERE agent_id IS NULL ORDER BY learned_at`,
  );
  const cap = 40;
  if (rows.length < cap * MEMORY_PRESSURE_THRESHOLD) {
    return { merged: 0, notes: [`memory at ${rows.length}/${cap} — below the consolidation threshold`] };
  }

  const raw = await cheapComplete(MERGE_PROMPT + rows.map((r) => r.content).join('\n'), {});
  if (!raw) return { merged: 0, notes: ['consolidation model returned nothing'] };

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { merged: 0, notes: ['could not parse merge proposal'] };

  let proposal: { merges?: Array<{ replaces?: string[]; with?: string }> };
  try {
    proposal = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { merged: 0, notes: ['merge proposal was not valid JSON'] };
  }

  let merged = 0;
  for (const m of proposal.merges ?? []) {
    if (!m.with || !Array.isArray(m.replaces) || m.replaces.length < 2) continue;

    // Only act on entries that exist verbatim. A merge referencing text that
    // does not match is the model paraphrasing, and applying it would silently
    // rewrite a fact into something nobody wrote.
    const existing = await query<{ id: string; content: string }>(
      `SELECT id, content FROM agent_memory WHERE agent_id IS NULL AND content = ANY($1::text[])`,
      [m.replaces],
    );
    if (existing.length !== m.replaces.length) {
      notes.push(`skipped a merge: ${m.replaces.length - existing.length} entries did not match verbatim`);
      continue;
    }
    if (m.with.length >= existing.reduce((n, e) => n + e.content.length, 0)) {
      notes.push('skipped a merge that was not shorter than what it replaced');
      continue;
    }

    await query(`DELETE FROM agent_memory WHERE id = ANY($1::uuid[])`, [existing.map((e) => e.id)]);
    await query(
      `INSERT INTO agent_memory (agent_id, kind, content, source)
       VALUES (NULL, 'convention', $1, $2)
       ON CONFLICT (agent_id, content) DO NOTHING`,
      [m.with, `consolidated from ${existing.length} entries`],
    );
    merged += existing.length - 1;

    await recordEvent({
      type: 'memory.consolidated',
      severity: 'info',
      message: `merged ${existing.length} memories into one`,
      data: { replaced: existing.map((e) => e.content), with: m.with },
    });
  }

  return { merged, notes };
}

/**
 * Archive skills nothing has opened.
 *
 * `use_count` is the only honest evidence available: the index costs tokens on
 * every turn of every session, and a skill nobody has ever loaded has returned
 * nothing for that. Archived rather than deleted, and only after a real
 * interval, because "never used yet" and "not useful" are different claims and
 * an emergency procedure earns its keep the one time it fires.
 */
async function curateSkills(olderThanDays: number): Promise<{ archived: number; notes: string[] }> {
  const stale = await query<{ name: string; age: number }>(
    `UPDATE skills
        SET enabled = false, updated_at = now()
      WHERE enabled
        AND use_count = 0
        AND created_at < now() - ($1 || ' days')::interval
        -- Authored skills are deliberate; a human wrote them for a reason that
        -- may not have arisen yet. Only learned ones are archived on silence.
        AND source = 'learned'
      RETURNING name, extract(day from now() - created_at)::int AS age`,
    [String(olderThanDays)],
  );

  const notes: string[] = [];
  for (const s of stale) {
    notes.push(`archived "${s.name}" — never opened in ${s.age} days`);
    await recordEvent({
      type: 'skill.archived',
      severity: 'info',
      message: `archived "${s.name}": never used in ${s.age} days`,
      data: { name: s.name },
    });
  }
  return { archived: stale.length, notes };
}

/** Near-duplicate skills, reported rather than merged. */
async function findDuplicateSkills(): Promise<string[]> {
  const pairs = await query<{ a: string; b: string }>(
    `SELECT s1.name AS a, s2.name AS b
       FROM skills s1 JOIN skills s2 ON s1.name < s2.name
      WHERE s1.enabled AND s2.enabled
        AND s1.tags && s2.tags
        -- Trigram-free heuristic: sharing tags and a leading word is a strong
        -- enough hint to be worth a human look, and cheap to compute.
        AND split_part(s1.name, '-', 1) = split_part(s2.name, '-', 1)`,
  );
  return pairs.map((p) => `possible duplicates: "${p.a}" and "${p.b}"`);
}

export async function curate(opts: { skillIdleDays?: number } = {}): Promise<CurationResult> {
  const mem = await curateMemory();
  const skills = await curateSkills(opts.skillIdleDays ?? 30);
  const dupes = await findDuplicateSkills();

  const result: CurationResult = {
    memoryMerged: mem.merged,
    skillsArchived: skills.archived,
    notes: [...mem.notes, ...skills.notes, ...dupes],
  };

  if (result.memoryMerged > 0 || result.skillsArchived > 0) {
    await recordEvent({
      type: 'curation.ran',
      severity: 'info',
      message: `curated: ${result.memoryMerged} memories merged, ${result.skillsArchived} skills archived`,
    });
  }
  return result;
}

/** What the stores currently cost, for the curator's own reporting. */
export async function storePressure(): Promise<{
  memory: { used: number; cap: number; pct: number };
  skills: { enabled: number; archived: number; unused: number };
}> {
  const m = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM agent_memory WHERE agent_id IS NULL`,
  );
  const s = await one<{ enabled: number; archived: number; unused: number }>(
    `SELECT count(*) FILTER (WHERE enabled)::int AS enabled,
            count(*) FILTER (WHERE NOT enabled)::int AS archived,
            count(*) FILTER (WHERE enabled AND use_count = 0)::int AS unused
       FROM skills`,
  );
  const used = m?.n ?? 0;
  return {
    memory: { used, cap: 40, pct: Math.round((used / 40) * 100) },
    skills: {
      enabled: s?.enabled ?? 0,
      archived: s?.archived ?? 0,
      unused: s?.unused ?? 0,
    },
  };
}
