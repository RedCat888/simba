import { query, one, recordEvent } from '../db/index.js';
import { captureGitState } from './git.js';
import { cheapComplete } from './cheap.js';

/**
 * Checkpoint authoring.
 *
 * Written every turn, not only at swap time. The rate-limit event gives useful
 * warning, but a turn can still die for reasons nothing predicted — a crash, a
 * reboot, the machine sleeping. A checkpoint that is always current means
 * detection can be reactive and recovery is still cheap, which is a far more
 * robust position than trying to predict exhaustion perfectly.
 */

export type CheckpointReason =
  | 'periodic'
  | 'limit_hit'
  | 'brain_swap'
  | 'manual'
  | 'session_end'
  | 'crash'
  | 'context_full'
  | 'handoff';

interface CheckpointFields {
  task_statement: string;
  work_done: string;
  work_remaining: string;
  failures: string;
  key_decisions: string;
  open_questions: string;
}

const EMPTY: CheckpointFields = {
  task_statement: '',
  work_done: '',
  work_remaining: '',
  failures: '',
  key_decisions: '',
  open_questions: '',
};

const PROMPT = `You are writing a handoff record so a different AI agent can take over
this work without repeating anything. Be specific and concrete. Name files,
commands, and errors exactly.

Return ONLY a JSON object with these string keys:
  task_statement   - what this session is trying to accomplish, in one or two sentences
  work_done        - what has actually been completed and verified
  work_remaining   - what still needs doing, in the order it should be attempted
  failures         - approaches already tried that did NOT work, and why. This is
                     the most important field: the next agent must not re-walk
                     these dead ends. If nothing failed, use an empty string.
  key_decisions    - choices made that constrain future work
  open_questions   - anything genuinely unresolved or needing the user

Transcript follows.
---
`;

function parseFields(raw: string | null): CheckpointFields {
  if (!raw) return { ...EMPTY };
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { ...EMPTY };
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<CheckpointFields>;
    return {
      task_statement: String(parsed.task_statement ?? ''),
      work_done: String(parsed.work_done ?? ''),
      work_remaining: String(parsed.work_remaining ?? ''),
      failures: String(parsed.failures ?? ''),
      key_decisions: String(parsed.key_decisions ?? ''),
      open_questions: String(parsed.open_questions ?? ''),
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * Renders the recent transcript for summarization. Tool calls are included but
 * their results truncated hard — what matters for a handoff is which tools ran
 * and whether they failed, not the full contents of every file read.
 */
async function renderRecentTranscript(sessionId: string, turnLimit = 12): Promise<string> {
  const messages = await query<{
    role: string;
    content: string | null;
    created_at: Date;
  }>(
    `SELECT role, content, created_at
       FROM messages
      WHERE session_id = $1 AND content IS NOT NULL AND content <> ''
      ORDER BY seq DESC
      LIMIT 120`,
    [sessionId],
  );

  const tools = await query<{
    name: string;
    args: unknown;
    is_error: boolean;
    result_text: string | null;
    created_at: Date;
  }>(
    `SELECT name, args, is_error, result_text, created_at
       FROM tool_calls
      WHERE session_id = $1
      ORDER BY created_at DESC
      LIMIT 60`,
    [sessionId],
  );

  const lines: string[] = [];
  for (const m of messages.reverse()) {
    lines.push(`[${m.role}] ${(m.content ?? '').slice(0, 3000)}`);
  }
  lines.push('\n--- recent tool calls ---');
  for (const t of tools.reverse()) {
    const args = JSON.stringify(t.args ?? {}).slice(0, 400);
    const outcome = t.is_error ? `ERROR: ${(t.result_text ?? '').slice(0, 500)}` : 'ok';
    lines.push(`${t.name}(${args}) -> ${outcome}`);
  }
  void turnLimit;
  return lines.join('\n');
}

export async function writeCheckpoint(
  sessionId: string,
  reason: CheckpointReason,
  opts: { turnId?: string | null; configDir?: string | null } = {},
): Promise<string | null> {
  const session = await one<{
    id: string;
    agent_id: string;
    cwd: string | null;
    worktree_path: string | null;
  }>(`SELECT id, agent_id, cwd, worktree_path FROM sessions WHERE id = $1`, [sessionId]);
  if (!session) return null;

  const workdir = session.worktree_path ?? session.cwd;
  const git = workdir ? await captureGitState(workdir) : null;

  const transcript = await renderRecentTranscript(sessionId);

  // A session with no transcript yet still gets a checkpoint row: the git state
  // alone is worth preserving, and an empty checkpoint is better than none when
  // recovery has to reason about what existed.
  const fields = transcript.trim()
    ? parseFields(await cheapComplete(PROMPT + transcript, { configDir: opts.configDir }))
    : { ...EMPTY };

  const row = await one<{ id: string }>(
    `INSERT INTO checkpoints
       (session_id, agent_id, turn_id, reason,
        task_statement, work_done, work_remaining, failures, key_decisions, open_questions,
        git_branch, git_head, git_dirty, git_diffstat, recent_files,
        token_estimate, generated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      sessionId,
      session.agent_id,
      opts.turnId ?? null,
      reason,
      fields.task_statement,
      fields.work_done,
      fields.work_remaining,
      fields.failures,
      fields.key_decisions,
      fields.open_questions,
      git?.branch ?? null,
      git?.head ?? null,
      git?.dirty ?? null,
      git?.diffstat ?? null,
      git?.recentFiles ?? [],
      Math.ceil(transcript.length / 4),
      'cheap',
    ],
  );

  await recordEvent({
    type: 'checkpoint.written',
    severity: 'debug',
    sessionId,
    agentId: session.agent_id,
    message: `checkpoint (${reason})`,
    data: { checkpointId: row?.id, dirty: git?.dirty ?? false },
  });

  return row?.id ?? null;
}

export async function latestCheckpoint(sessionId: string) {
  return one(`SELECT * FROM checkpoints WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`, [
    sessionId,
  ]);
}
