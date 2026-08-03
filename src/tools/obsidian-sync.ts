import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { query, one, recordEvent, closePool } from '../db/index.js';

/**
 * Writes Simba's conclusions back into the Obsidian vault.
 *
 * 63 vault notes were ingested and nothing ever went the other way, so
 * everything Simba worked out — decisions extracted from years of conversation,
 * what missions actually did — lived only in Postgres, which is not where
 * the operator reads. This closes that loop.
 *
 * Generated notes are owned by Simba and rewritten wholesale on each run. They
 * carry a `simba-generated` frontmatter flag and live under one folder, so
 * there is never ambiguity about what is safe to overwrite. Hand-written notes
 * are never touched.
 */

const VAULT = process.env.SIMBA_VAULT ?? 'C:\\Users\\operator\\OneDrive\\Documents\\Obsidian Vault';
const FOLDER = 'Simba';

/** Obsidian resolves links by filename, so these must be filesystem-safe. */
function safeName(s: string): string {
  return s
    .replace(/[\\/:*?"<>|#^[\]]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function frontmatter(fields: Record<string, string | string[]>): string {
  const lines = ['---', 'simba-generated: true'];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(Array.isArray(v) ? `${k}: [${v.map((x) => `"${x}"`).join(', ')}]` : `${k}: "${v}"`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Only rewrites when the body actually changed.
 *
 * Obsidian sync and the file watcher both react to mtime, so rewriting
 * identical content on every run would produce a stream of phantom changes and
 * make the vault's own history useless.
 */
async function writeIfChanged(path: string, content: string): Promise<boolean> {
  if (existsSync(path)) {
    const existing = await readFile(path, 'utf8').catch(() => '');
    // Compare below the frontmatter: the generated timestamp always differs.
    const strip = (s: string) => s.replace(/^---[\s\S]*?---\n/, '');
    if (strip(existing) === strip(content)) return false;
  }
  await writeFile(path, content, 'utf8');
  return true;
}

interface SyncStats {
  written: number;
  unchanged: number;
}

/** One note per topic, so the vault gets browsable clusters rather than a wall. */
async function syncDecisions(dir: string, stats: SyncStats): Promise<void> {
  // Firm decisions only.
  //
  // The extractor also captures things merely "stated" in passing, which on a
  // corpus containing years of homework means a lot of problem-solving
  // narration. That is fine to keep in Postgres for recall, but the vault is
  // something the operator reads — filling it with "I'm integrating this term by
  // term" would make the whole folder ignorable.
  const topics = await query<{ topic: string; n: number }>(
    `SELECT coalesce(topic, 'uncategorised') AS topic, count(*)::int AS n
       FROM decisions
      WHERE status = 'current'
        AND confidence IN ('acted_on', 'decided')
      GROUP BY 1
     HAVING count(*) >= 2
      ORDER BY n DESC
      LIMIT 60`,
  );

  const decisionsDir = join(dir, 'Decisions');
  await mkdir(decisionsDir, { recursive: true });

  for (const t of topics) {
    const rows = await query<{
      statement: string; rationale: string | null; confidence: string;
      decided_at: Date | null; replaced: string[] | null;
    }>(
      `SELECT d.statement, d.rationale, d.confidence, d.decided_at,
              coalesce(array_agg(p.statement) FILTER (WHERE p.id IS NOT NULL), '{}') AS replaced
         FROM decisions d
         LEFT JOIN decisions p ON p.superseded_by = d.id
        WHERE d.status = 'current'
          AND d.confidence IN ('acted_on', 'decided')
          AND coalesce(d.topic,'uncategorised') = $1
        GROUP BY d.id
        ORDER BY d.decided_at DESC NULLS LAST`,
      [t.topic],
    );

    const body = [
      frontmatter({
        topic: t.topic,
        tags: ['simba', 'decisions'],
        updated: new Date().toISOString().slice(0, 10),
      }),
      `# Decisions — ${t.topic}`,
      '',
      `_Extracted by Simba from conversation history. ${rows.length} current._`,
      '',
      ...rows.flatMap((r) => {
        const when = r.decided_at ? r.decided_at.toISOString().slice(0, 10) : 'undated';
        const out = [`## ${r.statement}`, '', `**${r.confidence}** · ${when}`, ''];
        if (r.rationale?.trim()) out.push(`${r.rationale}`, '');
        if (r.replaced && r.replaced.length > 0) {
          out.push('> Supersedes:');
          for (const p of r.replaced) out.push(`> - ${p}`);
          out.push('');
        }
        return out;
      }),
    ].join('\n');

    const path = join(decisionsDir, `${safeName(t.topic)}.md`);
    (await writeIfChanged(path, body)) ? stats.written++ : stats.unchanged++;
  }
}

async function syncMissions(dir: string, stats: SyncStats): Promise<void> {
  const missions = await query<{
    id: string; title: string; objective: string; status: string;
    done_steps: number; total_steps: number; created_at: Date;
  }>(
    `SELECT m.id, m.title, m.objective, m.status, mp.done_steps, mp.total_steps, m.created_at
       FROM missions m JOIN mission_progress mp ON mp.id = m.id
      ORDER BY m.created_at DESC LIMIT 40`,
  );
  if (missions.length === 0) return;

  const missionsDir = join(dir, 'Missions');
  await mkdir(missionsDir, { recursive: true });

  for (const m of missions) {
    const steps = await query<{ seq: number; title: string; kind: string; status: string; result: string | null }>(
      `SELECT seq, title, kind, status, left(coalesce(result,''), 400) AS result
         FROM mission_steps WHERE mission_id = $1 ORDER BY seq`,
      [m.id],
    );

    const body = [
      frontmatter({
        status: m.status,
        tags: ['simba', 'missions'],
        created: m.created_at.toISOString().slice(0, 10),
      }),
      `# ${m.title}`,
      '',
      `**${m.status}** · ${m.done_steps}/${m.total_steps} steps`,
      '',
      '## Objective',
      '',
      m.objective,
      '',
      '## Plan',
      '',
      ...steps.map(
        (s) =>
          `${s.status === 'succeeded' ? '- [x]' : '- [ ]'} **${s.seq}. ${s.title}** _(${s.kind})_` +
          (s.result?.trim() ? `\n    - ${s.result.replace(/\n/g, ' ')}` : ''),
      ),
      '',
    ].join('\n');

    const path = join(missionsDir, `${safeName(m.title)}.md`);
    (await writeIfChanged(path, body)) ? stats.written++ : stats.unchanged++;
  }
}

/** A single index note, so the folder has an obvious entry point. */
async function syncIndex(dir: string, stats: SyncStats): Promise<void> {
  const s = await one<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM decisions WHERE status='current')  AS decisions,
       (SELECT count(*)::int FROM missions)                          AS missions,
       (SELECT count(*)::int FROM knowledge_items)                   AS knowledge,
       (SELECT count(*)::int FROM embeddings)                        AS vectors,
       (SELECT count(*)::int FROM agents WHERE retired_at IS NULL)   AS agents`,
  );

  const recentBriefs = await query<{ headline: string; created_at: Date }>(
    `SELECT headline, created_at FROM briefs ORDER BY created_at DESC LIMIT 10`,
  );

  const body = [
    frontmatter({ tags: ['simba'], updated: new Date().toISOString().slice(0, 10) }),
    '# Simba',
    '',
    'Notes in this folder are generated by Simba and rewritten automatically.',
    'Edits here will be overwritten — write elsewhere in the vault instead.',
    '',
    '## State',
    '',
    `- ${s?.decisions ?? 0} current decisions`,
    `- ${s?.missions ?? 0} missions`,
    `- ${s?.knowledge ?? 0} knowledge items, ${s?.vectors ?? 0} vectors`,
    `- ${s?.agents ?? 0} agents`,
    '',
    ...(recentBriefs.length
      ? ['## Recent briefs', '', ...recentBriefs.map((b) => `- ${b.created_at.toISOString().slice(0, 10)} — ${b.headline}`), '']
      : []),
  ].join('\n');

  (await writeIfChanged(join(dir, 'Simba.md'), body)) ? stats.written++ : stats.unchanged++;
}

export async function syncToVault(): Promise<SyncStats> {
  const stats: SyncStats = { written: 0, unchanged: 0 };

  if (!existsSync(VAULT)) {
    console.error(`vault not found at ${VAULT}`);
    return stats;
  }

  const dir = join(VAULT, FOLDER);
  await mkdir(dir, { recursive: true });

  await syncDecisions(dir, stats);
  await syncMissions(dir, stats);
  await syncIndex(dir, stats);

  await recordEvent({
    type: 'obsidian.synced',
    message: `${stats.written} note(s) written, ${stats.unchanged} unchanged`,
    data: stats as unknown as Record<string, unknown>,
  });

  return stats;
}

if (process.argv[1]?.includes('obsidian-sync')) {
  syncToVault()
    .then((s) => console.log(`wrote ${s.written}, unchanged ${s.unchanged}`))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
