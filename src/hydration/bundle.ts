import { query, one } from '../db/index.js';
import { captureGitState } from './git.js';
import { recall } from '../knowledge/embed.js';

/**
 * Context assembly — the component that makes an agent an identity rather than
 * a process.
 *
 * The same bundle serves two cases that look different but are not:
 *   - continuing after a brain swap (hot worktree, seconds-old checkpoint)
 *   - picking up a conversation weeks later (cold, nothing running)
 * Failover is just cold resume with a shorter gap, so both go through here.
 *
 * The bundle is injected via --append-system-prompt rather than replayed as
 * message history. Replaying 200k tokens of transcript into a fresh session is
 * both expensive and worse than a compact, structured brief — the working tree
 * already carries the substance of what was done.
 */

export interface BundleOptions {
  /** The session being continued, if any. */
  continuingSessionId?: string | null;
  /** What the user just said, used to key semantic recall. */
  incomingMessage?: string | null;
  /** Verbatim turns to include from the most recent session. */
  verbatimMessages?: number;
  maxChars?: number;
}

function section(title: string, body: string | null | undefined): string {
  const text = (body ?? '').trim();
  if (!text) return '';
  return `\n## ${title}\n${text}\n`;
}

export async function buildHydrationBrief(
  agentId: string,
  opts: BundleOptions = {},
): Promise<string> {
  const agent = await one<{
    slug: string;
    name: string;
    tier: number;
    domain: string | null;
    description: string | null;
    standing_brief: string | null;
  }>(
    `SELECT slug, name, tier, domain, description, standing_brief
       FROM agents WHERE id = $1`,
    [agentId],
  );
  if (!agent) return '';

  const parts: string[] = [];

  parts.push(
    `# You are ${agent.name} (\`${agent.slug}\`), a tier-${agent.tier} agent in Simba.`,
    agent.domain ? `Domain: ${agent.domain}.` : '',
    agent.description ?? '',
    `\nYour durable memory lives in Simba's Postgres database, not in this context window` +
      ` and not in files. Use the Simba MCP tools to read and write it. Do not create` +
      ` markdown files to record state, plans, or handoffs — write documents and notes` +
      ` to the database instead. CLAUDE.md and AGENTS.md on disk are regenerated` +
      ` projections and any edit to them is discarded.`,
  );

  parts.push(section('Standing brief', agent.standing_brief));

  // ---- Prior work: rolling summaries across this agent's history ----------
  const summaries = await query<{ title: string | null; summary: string | null; created_at: Date }>(
    `SELECT title, summary, created_at
       FROM summaries
      WHERE agent_id = $1
      ORDER BY created_at DESC
      LIMIT 8`,
    [agentId],
  );
  if (summaries.length > 0) {
    parts.push(
      section(
        'Recent sessions (summarized)',
        summaries
          .map((s) => `- ${s.created_at.toISOString().slice(0, 10)} — ${s.title ?? 'untitled'}: ${s.summary ?? ''}`)
          .join('\n'),
      ),
    );
  }

  // ---- The checkpoint: the actual handoff ---------------------------------
  //
  // Only ever loaded for an explicit continuation. Falling back to "this
  // agent's most recent checkpoint" looks helpful and is actively harmful: a
  // fresh session for a brand-new task inherits an unrelated session's leftover
  // state and is told to resume it, so the agent argues with the user about a
  // task that no longer exists. Continuing is something the caller asks for.
  const checkpoint = !opts.continuingSessionId
    ? null
    : await one<{
    task_statement: string | null;
    work_done: string | null;
    work_remaining: string | null;
    failures: string | null;
    key_decisions: string | null;
    open_questions: string | null;
    git_branch: string | null;
    git_diffstat: string | null;
    recent_files: string[] | null;
    created_at: Date;
      }>(
        `SELECT * FROM checkpoints WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [opts.continuingSessionId],
      );

  if (checkpoint) {
    parts.push(
      `\n---\n# You are continuing work that was already underway.\n` +
        `A previous session was interrupted (brain limit, crash, or simply time passing).` +
        ` It was not your work in the sense of being in your context, but it is your work:` +
        ` same agent, same task. Pick it up where it stopped. Do not start over, and do not` +
        ` re-attempt anything listed under "Already tried and failed".`,
    );
    parts.push(section('The task', checkpoint.task_statement));
    parts.push(section('Already done', checkpoint.work_done));
    parts.push(section('Still to do', checkpoint.work_remaining));
    parts.push(section('Already tried and failed — do not repeat', checkpoint.failures));
    parts.push(section('Decisions that constrain you', checkpoint.key_decisions));
    parts.push(section('Open questions', checkpoint.open_questions));
  }

  // ---- Verbatim tail of the most recent session --------------------------
  if (opts.continuingSessionId) {
    const n = opts.verbatimMessages ?? 12;
    const recent = await query<{ role: string; content: string | null }>(
      `SELECT role, content FROM messages
        WHERE session_id = $1 AND content IS NOT NULL AND content <> ''
        ORDER BY seq DESC LIMIT $2`,
      [opts.continuingSessionId, n],
    );
    if (recent.length > 0) {
      parts.push(
        section(
          'Last exchanges, verbatim',
          recent
            .reverse()
            .map((m) => `[${m.role}] ${(m.content ?? '').slice(0, 1200)}`)
            .join('\n'),
        ),
      );
    }
  }

  // ---- Working tree ------------------------------------------------------
  const session = opts.continuingSessionId
    ? await one<{ cwd: string | null; worktree_path: string | null; branch: string | null }>(
        `SELECT cwd, worktree_path, branch FROM sessions WHERE id = $1`,
        [opts.continuingSessionId],
      )
    : null;

  const workdir = session?.worktree_path ?? session?.cwd ?? null;
  if (workdir) {
    const git = await captureGitState(workdir);
    const lines = [
      `Working directory: ${workdir}`,
      git.branch ? `Branch: ${git.branch}` : '',
      git.dirty ? 'The working tree has uncommitted changes — they are the previous session\'s work, inherited by you.' : 'Working tree is clean.',
      git.diffstat ? `\nUncommitted diff:\n${git.diffstat}` : '',
      git.recentCommits.length ? `\nRecent commits:\n${git.recentCommits.join('\n')}` : '',
    ].filter(Boolean);
    parts.push(section('Working tree state', lines.join('\n')));
  }

  // ---- Semantic recall ---------------------------------------------------
  if (opts.incomingMessage) {
    const hits = await recall(opts.incomingMessage, { limit: 6, agentId });
    if (hits.length > 0) {
      parts.push(
        section(
          'Possibly relevant, recalled from memory',
          hits
            .map((h) => `- (${h.source}) ${h.title ?? ''}: ${h.content.slice(0, 500)}`)
            .join('\n'),
        ),
      );
    }
  }

  const brief = parts.filter(Boolean).join('\n');
  const max = opts.maxChars ?? 24_000;
  return brief.length > max ? brief.slice(0, max) + '\n…[brief truncated]' : brief;
}
