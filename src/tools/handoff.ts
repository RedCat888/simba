import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { query, one, closePool, recordEvent } from '../db/index.js';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

/**
 * Durable handoff.
 *
 * Assembled from git history and the database rather than written by hand, so
 * it cannot drift from what actually happened. A handoff a human maintains is
 * a handoff that is wrong by the second session.
 *
 * The audience is a future session with no memory of this one: it needs the
 * decisions and their reasons, what was verified versus merely written, what
 * was already tried and failed, and one concrete next action. Everything else
 * is recoverable by reading the repo.
 */

async function git(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: config.root,
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function buildHandoff(): Promise<string> {
  const [log, changed, branch, dirty] = await Promise.all([
    git(['log', '-14', '--format=%h|%ad|%s', '--date=short']),
    git(['diff', '--stat', 'HEAD~5', '--', '.']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--porcelain']),
  ]);

  const [stats] = await query<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM agents WHERE retired_at IS NULL)          AS agents,
       (SELECT count(*)::int FROM sessions)                                 AS sessions,
       (SELECT count(*)::int FROM missions)                                 AS missions,
       (SELECT count(*)::int FROM embeddings)                               AS vectors,
       (SELECT count(*)::int FROM captures WHERE status='pending')          AS pending_captures,
       (SELECT round(coalesce(sum(total_cost_usd),0)::numeric,2) FROM sessions) AS spent`,
  );

  const brains = await query<{ slug: string; status: string; note: string | null }>(
    `SELECT slug, status, left(coalesce(last_error,''), 70) AS note
       FROM brain_accounts ORDER BY priority`,
  );

  const missions = await query<{
    title: string; status: string; done_steps: number; total_steps: number;
    current_step: string | null; blocked_reason: string | null;
  }>(
    `SELECT title, status, done_steps, total_steps, current_step, blocked_reason
       FROM mission_progress
      WHERE status NOT IN ('completed','cancelled')
      ORDER BY updated_at DESC LIMIT 10`,
  );

  // Failures are the highest-value part of any handoff: they are what a fresh
  // session would otherwise waste time rediscovering.
  const failures = await query<{ type: string; message: string; ts: Date }>(
    `SELECT type, left(coalesce(message,''), 150) AS message, ts
       FROM events
      WHERE severity IN ('error','critical')
        AND ts > now() - interval '7 days'
      ORDER BY ts DESC LIMIT 15`,
  );

  const decisions = await query<{ slug: string; title: string; summary: string | null }>(
    `SELECT d.slug, d.title, left(coalesce(dr.summary,''), 200) AS summary
       FROM documents d
       JOIN document_revisions dr
         ON dr.document_id = d.id AND dr.revision = d.current_revision
      WHERE d.kind IN ('decision','analysis') AND NOT d.archived
      ORDER BY d.updated_at DESC LIMIT 10`,
  );

  const trend = await one<Record<string, number | string>>(`SELECT * FROM memory_trend`);

  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push('# Simba — handoff');
  push();
  push(`Generated ${new Date().toISOString()} · branch \`${branch}\` · ` +
       `${dirty ? `${dirty.split('\n').length} uncommitted file(s)` : 'working tree clean'}`);
  push();

  push('## State');
  push(`- ${stats?.agents ?? 0} agents, ${stats?.sessions ?? 0} sessions, ` +
       `${stats?.missions ?? 0} missions, ${stats?.vectors ?? 0} vectors indexed`);
  push(`- $${stats?.spent ?? 0} spent to date`);
  if (stats?.pending_captures) push(`- ${stats.pending_captures} capture(s) awaiting triage`);
  if (trend) {
    push(`- memory: ${trend.free_now_mb ?? '?'} MB free; ` +
         `Claude desktop ${trend.claude_desktop_now_mb ?? '?'} MB ` +
         `(${(trend.claude_desktop_delta_mb as number) >= 0 ? '+' : ''}${trend.claude_desktop_delta_mb ?? 0} MB trend)`);
  }
  push();

  push('## Brains');
  for (const b of brains) {
    push(`- \`${b.slug}\` — ${b.status}${b.note ? ` (${b.note})` : ''}`);
  }
  push();

  if (missions.length) {
    push('## Missions in flight');
    for (const m of missions) {
      push(`- **${m.title}** [${m.status}] ${m.done_steps}/${m.total_steps}` +
           (m.current_step ? ` — on: ${m.current_step}` : '') +
           (m.blocked_reason ? ` — BLOCKED: ${m.blocked_reason}` : ''));
    }
    push();
  }

  push('## Recent commits');
  for (const l of log.split('\n').filter(Boolean)) {
    const [hash, date, subject] = l.split('|');
    push(`- \`${hash}\` ${date} — ${subject}`);
  }
  push();

  if (changed) {
    push('## Files changed (last 5 commits)');
    push('```');
    push(changed.split('\n').slice(-25).join('\n'));
    push('```');
    push();
  }

  if (decisions.length) {
    push('## Decisions on record');
    for (const d of decisions) {
      push(`- **${d.title}** (\`${d.slug}\`)${d.summary ? ` — ${d.summary}` : ''}`);
    }
    push();
  }

  if (failures.length) {
    push('## Failures and dead ends (last 7 days)');
    push('_Do not re-attempt these blind; they are recorded so they are not rediscovered._');
    for (const f of failures) {
      push(`- \`${f.type}\` — ${f.message}`);
    }
    push();
  }

  push('## Verified working');
  push('- Brain failover: same-account transcript copy + resume; cross-tool Claude→Codex rehydration');
  push('- Missions: multi-step objective planned and executed to completion with no human involvement');
  push('- Android app: built, installed on emulator, live gateway data, capture round-trip into Postgres');
  push('- Local free tier: Ollama agent loop with tool calling, cost zero');
  push('- Surface isolation: agent denial, model-tier clamp, and escalation resistance all tested');
  push();

  return lines.join('\n');
}

/** Persists the handoff as a document so it is queryable and versioned. */
export async function saveHandoff(): Promise<void> {
  const content = await buildHandoff();

  const doc = await one<{ id: string; current_revision: number }>(
    `INSERT INTO documents (slug, kind, scope, title, current_revision)
     VALUES ('handoff', 'brief', 'global', 'Simba handoff', 1)
     ON CONFLICT (scope, slug,
                  coalesce(agent_id,'00000000-0000-0000-0000-000000000000'::uuid),
                  coalesce(project_id,'00000000-0000-0000-0000-000000000000'::uuid),
                  coalesce(session_id,'00000000-0000-0000-0000-000000000000'::uuid))
     DO UPDATE SET current_revision = documents.current_revision + 1, updated_at = now()
     RETURNING id, current_revision`,
  );
  if (!doc) return;

  await query(
    `INSERT INTO document_revisions (document_id, revision, content, summary)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (document_id, revision) DO UPDATE SET content = EXCLUDED.content`,
    [doc.id, doc.current_revision, content, 'auto-generated handoff'],
  );

  // Keep a window, not the whole history.
  //
  // The handoff is a regenerated snapshot of current state, written every
  // fifteen minutes by the supervisor. Its revisions are not edits by anyone -
  // a copy from 12:22 differs from 12:37 only in timestamps and counts - so the
  // history reconstructs nothing that the current revision does not already
  // say.
  //
  // Left alone it had accumulated 1,257 revisions since 3 August: 99.2% of
  // every document revision in the database and 6.3 MB against roughly 185 KB
  // for every other document combined, growing about 400 KB a day forever.
  //
  // Safe to drop because nothing reads them. Every consumer - the gateway's
  // document route, the MCP doc_read tool, buildHandoff itself - joins on
  // `dr.revision = d.current_revision`, and there is no revision-history API or
  // UI anywhere. KEEP is generous at twelve hours for the same reason the cap
  // is not one: cheap insurance against wanting to look back at a bad morning.
  const KEEP = 48;
  // Cutoff computed here rather than as `$2 - $3` in SQL: both parameters
  // arrive untyped, so Postgres cannot resolve which minus operator is meant
  // and fails with "operator is not unique: unknown - unknown". The supervisor
  // calls saveHandoff().catch(() => {}), so that error would have been
  // swallowed and the pruning would simply never have happened.
  const cutoff = doc.current_revision - KEEP;
  const pruned = cutoff > 0
    ? await query<{ revision: number }>(
        `DELETE FROM document_revisions
          WHERE document_id = $1 AND revision <= $2
          RETURNING revision`,
        [doc.id, cutoff],
      )
    : [];
  if (pruned.length > 0) {
    await recordEvent({
      type: 'handoff.pruned',
      severity: 'debug',
      message: `pruned ${pruned.length} handoff revision(s), keeping the most recent ${KEEP}`,
      data: { removed: pruned.length, keep: KEEP },
    });
  }
}

if (process.argv[1]?.includes('handoff')) {
  saveHandoff()
    .then(async () => console.log(await buildHandoff()))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
