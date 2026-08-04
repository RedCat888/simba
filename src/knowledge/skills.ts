import { query, one, recordEvent } from '../db/index.js';

/**
 * Skills: procedures the system learns once and reuses.
 *
 * The whole design follows from one economic fact, which is Hermes Agent's
 * insight and worth restating because it is easy to get backwards: a skill's
 * description is paid for on *every* turn, because the index must sit in the
 * system prompt for an agent to know the skill exists. Its body is paid for
 * only when the skill is actually opened.
 *
 * So the index is deliberately impoverished — a name and 57 characters — and
 * everything else loads on demand. A skill whose description does not lead with
 * its trigger is useless in the index, because the trigger is the only part
 * that survives truncation.
 */

/** Matches Hermes' SKILL_PROMPT_DESC_LIMIT. 60 minus the ellipsis. */
const INDEX_DESC_LIMIT = 57;

/**
 * How many skills may appear in the index at once.
 *
 * A ceiling has to exist or the system prompt grows without bound as agents
 * write more skills. When it bites, the overflow is reported rather than
 * silently dropped — a truncated index that looks complete would have agents
 * confidently concluding a capability does not exist.
 */
const INDEX_MAX = 60;

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  body: string;
  tags: string[];
  related: string[];
  source: string;
  version: number;
  use_count: number;
  updated_at: Date;
}

function truncate(desc: string): string {
  const clean = desc.replace(/\s+/g, ' ').trim();
  return clean.length > INDEX_DESC_LIMIT
    ? `${clean.slice(0, INDEX_DESC_LIMIT - 3)}...`
    : clean;
}

/**
 * The index that goes in the system prompt.
 *
 * Ordered by use, so the skills that have actually earned their place appear
 * first and any truncation falls on the ones nothing has ever opened.
 */
export async function buildSkillIndex(agentSlug: string): Promise<string | null> {
  const rows = await query<{ name: string; description: string }>(
    `SELECT name, description
       FROM skills
      WHERE enabled
        -- Empty applies_to_agents means "everywhere", which is the common case.
        AND (cardinality(applies_to_agents) = 0 OR $1 = ANY (applies_to_agents))
        AND (cardinality(platforms) = 0 OR $2 = ANY (platforms))
      ORDER BY use_count DESC, name
      LIMIT $3`,
    [agentSlug, process.platform, INDEX_MAX + 1],
  );

  if (rows.length === 0) return null;

  const shown = rows.slice(0, INDEX_MAX);
  const lines = shown.map((r) => `- \`${r.name}\` — ${truncate(r.description)}`);

  if (rows.length > INDEX_MAX) {
    // Never a silent cap: an agent that cannot see the rest must at least know
    // the rest is there and how to reach it.
    lines.push(
      `- …more skills exist beyond this index. Call \`skill_list\` to see all of them.`,
    );
  }

  return lines.join('\n');
}

/**
 * Loads a skill body and records that it was used.
 *
 * The usage count is the only evidence available about whether a skill is
 * earning the prompt space it occupies every turn, so it is written here rather
 * than left to callers to remember.
 */
export async function viewSkill(name: string): Promise<SkillRow | null> {
  const row = await one<SkillRow>(
    `UPDATE skills
        SET use_count = use_count + 1,
            last_used_at = now()
      WHERE name = $1 AND enabled
      RETURNING id, name, description, body, tags, related, source, version, use_count, updated_at`,
    [name],
  );
  return row ?? null;
}

/** Full descriptions, untruncated — for when the index was not enough. */
export async function listSkills(): Promise<Array<Pick<SkillRow, 'name' | 'description' | 'tags' | 'use_count'>>> {
  return query(
    `SELECT name, description, tags, use_count
       FROM skills
      WHERE enabled
      ORDER BY use_count DESC, name`,
  );
}

export interface SaveSkillInput {
  name: string;
  description: string;
  body: string;
  tags?: string[];
  related?: string[];
  sessionId?: string | null;
  source?: 'authored' | 'learned' | 'imported';
  note?: string;
}

/**
 * Creates a skill, or revises one that already exists.
 *
 * Agents are told to write skills mid-task, which means this is called by a
 * model that may be wrong. Every write therefore keeps the version it replaced:
 * a bad revision is recoverable, and it is possible to see what a skill used to
 * say. Deleting is deliberately not offered — disabling is enough, and a
 * procedure someone bothered to write is worth more than the row it occupies.
 */
export async function saveSkill(input: SaveSkillInput): Promise<{ name: string; version: number; created: boolean }> {
  const name = input.name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(`invalid skill name "${input.name}" — use lowercase kebab-case, max 64 chars`);
  }

  const existing = await one<{ id: string; version: number; description: string; body: string }>(
    `SELECT id, version, description, body FROM skills WHERE name = $1`,
    [name],
  );

  if (!existing) {
    const row = await one<{ id: string }>(
      `INSERT INTO skills (name, description, body, tags, related, source, created_by_session)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        name,
        input.description.trim(),
        input.body,
        input.tags ?? [],
        input.related ?? [],
        input.source ?? 'learned',
        input.sessionId ?? null,
      ],
    );

    await query(
      `INSERT INTO skill_revisions (skill_id, version, description, body, note, created_by_session)
       VALUES ($1, 1, $2, $3, $4, $5)`,
      [row!.id, input.description.trim(), input.body, input.note ?? 'created', input.sessionId ?? null],
    );

    await recordEvent({
      type: 'skill.created',
      severity: 'info',
      sessionId: input.sessionId ?? undefined,
      message: `skill "${name}" created`,
      data: { name, source: input.source ?? 'learned' },
    });

    return { name, version: 1, created: true };
  }

  const version = existing.version + 1;

  // The version being replaced is archived, not the new one — so the history
  // reads as "what it was before this change".
  await query(
    `INSERT INTO skill_revisions (skill_id, version, description, body, note, created_by_session)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (skill_id, version) DO NOTHING`,
    [
      existing.id,
      existing.version,
      existing.description,
      existing.body,
      input.note ?? 'superseded',
      input.sessionId ?? null,
    ],
  );

  await query(
    `UPDATE skills
        SET description = $2, body = $3,
            tags    = COALESCE(NULLIF($4::text[], '{}'), tags),
            related = COALESCE(NULLIF($5::text[], '{}'), related),
            version = $6,
            updated_at = now()
      WHERE id = $1`,
    [
      existing.id,
      input.description.trim(),
      input.body,
      input.tags ?? [],
      input.related ?? [],
      version,
    ],
  );

  await recordEvent({
    type: 'skill.revised',
    severity: 'info',
    sessionId: input.sessionId ?? undefined,
    message: `skill "${name}" revised to v${version}`,
    data: { name, version, note: input.note ?? null },
  });

  return { name, version, created: false };
}

/** Prior versions, newest first. */
export async function skillHistory(name: string) {
  return query(
    `SELECT r.version, r.description, r.note, r.created_at
       FROM skill_revisions r
       JOIN skills s ON s.id = r.skill_id
      WHERE s.name = $1
      ORDER BY r.version DESC`,
    [name],
  );
}

/**
 * Skills that have never been opened despite sitting in the index.
 *
 * Every one of these costs tokens on every turn of every session and has
 * returned nothing so far. Reported rather than auto-pruned: "never used" and
 * "not useful" are different claims, and a skill for a rare emergency is
 * exactly the kind that earns its keep the one time it fires.
 */
export async function unusedSkills(olderThanDays = 30) {
  return query<{ name: string; created_at: Date }>(
    `SELECT name, created_at
       FROM skills
      WHERE enabled AND use_count = 0
        AND created_at < now() - ($1 || ' days')::interval
      ORDER BY created_at`,
    [String(olderThanDays)],
  );
}
