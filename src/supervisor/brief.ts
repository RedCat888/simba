import { query, one, recordEvent } from '../db/index.js';
import { cheapComplete } from '../hydration/cheap.js';

/**
 * Periodic brief generation.
 *
 * Answers "what is happening and where is it going" without making the reader
 * wade through transcripts. Raw agent output is the wrong thing to push to a
 * phone: it is high volume, low signal, and it hides whether anything is
 * actually progressing.
 *
 * Only produced while something is running. A brief that says "nothing is
 * happening" every half hour trains you to ignore briefs.
 */

const PROMPT = `Summarize what these AI agents are doing for their operator, who is not watching.

Write for someone who wants to know whether things are on track, not what was typed. Rules:
- Lead with direction and progress, never with tool output.
- Be specific: name the project, the mission, the actual obstacle.
- If something is stuck or looping, say so plainly.
- If something genuinely needs a human decision, say exactly what the decision is.
- No praise, no filler, no restating the input.

Return ONLY JSON with keys:
  "headline"       - one line, under 100 chars, what matters most right now
  "body"           - 2-5 short sentences of direction and progress
  "needs_decision" - what requires the operator, or "" if nothing does
  "stuck"          - what is stalled or looping, or "" if nothing is

Activity follows.
---
`;

interface BriefFields {
  headline: string;
  body: string;
  needs_decision: string;
  stuck: string;
}

function parse(raw: string | null): BriefFields | null {
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const o = JSON.parse(raw.slice(start, end + 1)) as Partial<BriefFields>;
    if (!o.headline && !o.body) return null;
    return {
      headline: String(o.headline ?? 'Agents active'),
      body: String(o.body ?? ''),
      needs_decision: String(o.needs_decision ?? ''),
      stuck: String(o.stuck ?? ''),
    };
  } catch {
    return null;
  }
}

/**
 * Builds a brief if enough has happened to justify one.
 * Returns null when there is nothing worth saying.
 */
export async function generateBrief(minIntervalMinutes = 30): Promise<string | null> {
  const last = await one<{ created_at: Date }>(
    `SELECT created_at FROM briefs ORDER BY created_at DESC LIMIT 1`,
  );
  const since = last?.created_at ?? new Date(Date.now() - 60 * 60_000);

  if (last && Date.now() - last.created_at.getTime() < minIntervalMinutes * 60_000) {
    return null;
  }

  const [activity] = await query<{
    active_agents: number;
    active_missions: number;
    turns: number;
    cost: number;
  }>(
    `SELECT
       (SELECT count(DISTINCT agent_id)::int FROM sessions
         WHERE status IN ('running','idle','waiting_limit'))                     AS active_agents,
       (SELECT count(*)::int FROM missions
         WHERE status IN ('planning','running','verifying','blocked'))           AS active_missions,
       (SELECT count(*)::int FROM turns WHERE started_at > $1)                   AS turns,
       (SELECT coalesce(sum(cost_usd),0) FROM turns WHERE started_at > $1)       AS cost`,
    [since],
  );

  // Nothing running and nothing happened: staying quiet is the correct output.
  if (!activity || (activity.active_agents === 0 && activity.active_missions === 0 && activity.turns === 0)) {
    return null;
  }

  const missions = await query<{
    title: string; status: string; current_step: string | null;
    done_steps: number; total_steps: number; blocked_reason: string | null;
  }>(
    `SELECT title, status, current_step, done_steps, total_steps, blocked_reason
       FROM mission_progress
      WHERE status IN ('planning','running','verifying','blocked')
      ORDER BY updated_at DESC LIMIT 10`,
  );

  const sessions = await query<{
    agent: string; status: string; title: string | null; brain: string | null;
  }>(
    `SELECT a.slug AS agent, s.status, s.title, b.slug AS brain
       FROM sessions s
       JOIN agents a ON a.id = s.agent_id
       LEFT JOIN brain_accounts b ON b.id = s.brain_account_id
      WHERE s.last_activity_at > $1 OR s.status IN ('running','idle','waiting_limit')
      ORDER BY s.last_activity_at DESC NULLS LAST LIMIT 12`,
    [since],
  );

  const notable = await query<{ type: string; message: string | null }>(
    `SELECT type, message FROM events
      WHERE ts > $1
        AND (severity IN ('warn','error','critical')
             OR type IN ('brain.swap','mission.completed','mission.blocked',
                         'session.sleeping_until_reset','router.escalated'))
      ORDER BY ts DESC LIMIT 15`,
    [since],
  );

  const recentWork = await query<{ agent: string; content: string }>(
    `SELECT a.slug AS agent, left(m.content, 300) AS content
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN agents a ON a.id = s.agent_id
      WHERE m.role = 'assistant' AND m.content IS NOT NULL AND m.created_at > $1
      ORDER BY m.created_at DESC LIMIT 12`,
    [since],
  );

  const input = [
    `Window: ${since.toISOString()} to now. ${activity.turns} turns, $${Number(activity.cost).toFixed(4)} spent.`,
    missions.length
      ? `\nMissions:\n${missions
          .map((m) =>
            `- "${m.title}" [${m.status}] ${m.done_steps}/${m.total_steps} steps` +
            (m.current_step ? `, on: ${m.current_step}` : '') +
            (m.blocked_reason ? `, BLOCKED: ${m.blocked_reason}` : ''),
          )
          .join('\n')}`
      : '',
    sessions.length
      ? `\nSessions:\n${sessions
          .map((s) => `- ${s.agent} [${s.status}] ${s.title ?? 'untitled'} (${s.brain ?? 'n/a'})`)
          .join('\n')}`
      : '',
    notable.length
      ? `\nNotable events:\n${notable.map((e) => `- ${e.type}: ${e.message ?? ''}`).join('\n')}`
      : '',
    recentWork.length
      ? `\nRecent agent output:\n${recentWork.map((w) => `- [${w.agent}] ${w.content}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const fields = parse(await cheapComplete(PROMPT + input, { maxChars: 30_000 }));
  if (!fields) return null;

  const row = await one<{ id: string }>(
    `INSERT INTO briefs (kind, headline, body, needs_decision, stuck,
                         active_agents, active_missions, cost_since_last,
                         covers_from, model)
     VALUES ('periodic',$1,$2,$3,$4,$5,$6,$7,$8,'cheap')
     RETURNING id`,
    [
      fields.headline,
      fields.body,
      fields.needs_decision || null,
      fields.stuck || null,
      activity.active_agents,
      activity.active_missions,
      activity.cost,
      since,
    ],
  );

  await recordEvent({
    type: 'brief.generated',
    message: fields.headline,
    data: { needsDecision: Boolean(fields.needs_decision), stuck: Boolean(fields.stuck) },
  });

  return row?.id ?? null;
}
