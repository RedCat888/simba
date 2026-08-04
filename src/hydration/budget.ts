import { query, one } from '../db/index.js';
import { buildHydrationBrief } from './bundle.js';
import { buildSkillIndex } from '../knowledge/skills.js';
import { buildMemorySection } from '../knowledge/memory.js';

/**
 * Where the context window actually goes.
 *
 * Every turn pays for the brief, and the brief has been growing all night —
 * memory, a skills index, summaries, checkpoints, git state, semantic recall.
 * Each addition was individually justified and nothing was measuring the total,
 * which is precisely how a context window fills with things nobody would have
 * chosen to spend it on.
 *
 * Taken from Hermes' context-usage popover, which breaks the window down by
 * category rather than showing one number. The single number tells you that you
 * are in trouble; the breakdown tells you what to cut.
 *
 * Token counts are estimates. Nothing here has a tokeniser for five different
 * model families, and chars/4 is close enough to answer the question being
 * asked, which is "what is the big one" and not "exactly how many". Reported as
 * estimates so nobody builds a billing system on them.
 */

const CHARS_PER_TOKEN = 4;

export interface BudgetSlice {
  category: string;
  chars: number;
  estTokens: number;
  /** Share of the assembled brief, so the largest is obvious at a glance. */
  pct: number;
  note?: string;
}

export interface ContextBudget {
  agent: string;
  totalChars: number;
  estTokens: number;
  slices: BudgetSlice[];
  /** What the session has actually consumed, when measuring a live one. */
  session?: {
    inputTokens: number;
    outputTokens: number;
    turns: number;
  };
}

export async function measureContext(
  agentSlug: string,
  opts: { sessionId?: string | null } = {},
): Promise<ContextBudget | null> {
  const agent = await one<{ id: string; slug: string; standing_brief: string | null }>(
    `SELECT id, slug, standing_brief FROM agents WHERE slug = $1 AND retired_at IS NULL`,
    [agentSlug],
  );
  if (!agent) return null;

  // Each piece measured on its own, then the whole brief measured for real.
  // Summing the parts would quietly miss the framing text between sections,
  // which is exactly the kind of overhead that goes unnoticed.
  const [memory, skills, brief] = await Promise.all([
    buildMemorySection(agent.id),
    buildSkillIndex(agent.slug),
    buildHydrationBrief(agent.id, { continuingSessionId: opts.sessionId ?? null }),
  ]);

  const summaries = await query<{ n: number; chars: number }>(
    `SELECT count(*)::int AS n,
            coalesce(sum(length(coalesce(title,'') || coalesce(summary,''))), 0)::int AS chars
       FROM (SELECT title, summary FROM summaries
              WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 8) s`,
    [agent.id],
  );

  const checkpoint = opts.sessionId
    ? await one<{ chars: number }>(
        `SELECT coalesce(length(
                  coalesce(task_statement,'') || coalesce(work_done,'') ||
                  coalesce(work_remaining,'') || coalesce(failures,'') ||
                  coalesce(key_decisions,'') || coalesce(open_questions,'')
                ), 0)::int AS chars
           FROM checkpoints WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [opts.sessionId],
      )
    : null;

  const measured: Array<{ category: string; chars: number; note?: string }> = [
    {
      category: 'identity',
      chars: (agent.standing_brief ?? '').length + 400,
      note: 'role, standing brief, and the no-markdown rule',
    },
    { category: 'memory', chars: (memory ?? '').length, note: 'facts present every turn' },
    { category: 'skills index', chars: (skills ?? '').length, note: 'names and triggers only' },
    { category: 'past summaries', chars: summaries[0]?.chars ?? 0, note: `${summaries[0]?.n ?? 0} sessions` },
  ];
  if (checkpoint) {
    measured.push({ category: 'checkpoint', chars: checkpoint.chars, note: 'handoff from the interrupted session' });
  }

  const total = brief.length;
  const accounted = measured.reduce((n, m) => n + m.chars, 0);
  // Whatever the named sections do not explain: git state, semantic recall,
  // verbatim tail, and section framing. Named rather than hidden, because an
  // unexplained remainder is the thing most likely to be growing.
  measured.push({
    category: 'everything else',
    chars: Math.max(0, total - accounted),
    note: 'git state, recall, verbatim tail, section headers',
  });

  const slices: BudgetSlice[] = measured
    .filter((m) => m.chars > 0)
    .map((m) => ({
      category: m.category,
      chars: m.chars,
      estTokens: Math.round(m.chars / CHARS_PER_TOKEN),
      pct: total > 0 ? Math.round((m.chars / total) * 100) : 0,
      note: m.note,
    }))
    .sort((a, b) => b.chars - a.chars);

  const budget: ContextBudget = {
    agent: agent.slug,
    totalChars: total,
    estTokens: Math.round(total / CHARS_PER_TOKEN),
    slices,
  };

  if (opts.sessionId) {
    const usage = await one<{ input: number; output: number; turns: number }>(
      `SELECT coalesce(sum(input_tokens),0)::int AS input,
              coalesce(sum(output_tokens),0)::int AS output,
              count(*)::int AS turns
         FROM turns WHERE session_id = $1`,
      [opts.sessionId],
    );
    if (usage) {
      budget.session = {
        inputTokens: usage.input,
        outputTokens: usage.output,
        turns: usage.turns,
      };
    }
  }

  return budget;
}
