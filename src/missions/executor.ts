import { query, one, recordEvent } from '../db/index.js';
import type { SessionManager } from '../session/manager.js';

/**
 * The mission executor.
 *
 * Deterministic, like the supervisor: it decides *that* a step should run and
 * spawns a session for it. Deciding *how* — decomposing the objective, judging
 * whether a step really succeeded — is model work, done inside sessions and
 * recorded back as data.
 *
 * The loop is what makes autonomy real. A session that dies from a rate limit,
 * a crash, or a reboot leaves its step in 'running' with a live session that no
 * longer exists; the next tick notices, reopens it, and the mission continues.
 * Nothing here needs the user to be awake.
 */

const PLANNING_PROMPT = `You are planning how to accomplish an objective autonomously, with no human help available at any point.

Break it into concrete ordered steps and record them with the mission_plan tool. Requirements:

- Assume NOTHING is installed. If the objective needs a toolchain, SDK, emulator or runtime, include explicit 'provision' steps to install and configure it, and a step to verify the install actually works before depending on it.
- Include 'research' steps wherever you would otherwise be guessing — exact package names, current CLI flags, project layout conventions.
- Every step's instruction must be self-contained. A different model on a different day will execute it with only the mission objective and that instruction for context.
- Finish with at least one 'verify' step that actually runs the thing end to end and checks real output. Building successfully is not verification.
- Prefer more, smaller steps. A step should be one session's worth of work.

Call mission_plan exactly once with the full list, then stop. Do not start doing the work.`;

export interface ExecutorStats {
  planned: number;
  started: number;
  reopened: number;
  completed: number;
  blocked: number;
}

export class MissionExecutor {
  constructor(private readonly manager: SessionManager) {}

  async tick(): Promise<ExecutorStats> {
    const stats: ExecutorStats = { planned: 0, started: 0, reopened: 0, completed: 0, blocked: 0 };

    stats.reopened += await this.reopenOrphanedSteps();
    stats.blocked += await this.enforceBudgets();
    stats.planned += await this.planMissions();
    stats.started += await this.runSteps();
    stats.completed += await this.finishMissions();
    await this.wakeScheduled();

    return stats;
  }

  /**
   * A step marked running whose session is gone — killed by a limit, a crash,
   * or a restart. This is the single most important behaviour in the class: it
   * is what lets a mission survive everything that can interrupt it.
   */
  private async reopenOrphanedSteps(): Promise<number> {
    const orphans = await query<{ id: string; mission_id: string; title: string }>(
      `SELECT s.id, s.mission_id, s.title
         FROM mission_steps s
         LEFT JOIN sessions ss ON ss.id = s.session_id
        WHERE s.status = 'running'
          AND (ss.id IS NULL OR ss.status IN ('failed','killed','completed','superseded'))`,
    );

    for (const o of orphans) {
      const live = this.manager.listLive().some((l) => l.sessionId === o.id);
      if (live) continue;

      await query(
        `UPDATE mission_steps SET status = 'pending', session_id = NULL WHERE id = $1`,
        [o.id],
      );
      await this.log(o.mission_id, `step "${o.title}" was interrupted; requeued`, 'warn', o.id);
    }
    return orphans.length;
  }

  /** Stop conditions. An autonomous loop without them is just an expensive one. */
  private async enforceBudgets(): Promise<number> {
    const rows = await query<{ id: string; title: string; reason: string }>(
      `UPDATE missions
          SET status = 'blocked',
              blocked_reason = CASE
                WHEN sessions_used >= max_sessions THEN 'session budget exhausted'
                WHEN cost_used_usd >= max_cost_usd THEN 'cost budget exhausted'
                WHEN consecutive_failures >= max_consecutive_failures
                     THEN 'too many consecutive failures without progress'
                ELSE 'deadline passed' END
        WHERE status = 'running'
          AND (sessions_used >= max_sessions
               OR cost_used_usd >= max_cost_usd
               OR consecutive_failures >= max_consecutive_failures
               OR (deadline IS NOT NULL AND deadline < now()))
        RETURNING id, title, blocked_reason AS reason`,
    );

    for (const r of rows) {
      await this.log(r.id, `mission blocked: ${r.reason}`, 'error');
      await recordEvent({
        type: 'mission.blocked',
        severity: 'warn',
        message: `"${r.title}" blocked: ${r.reason}`,
      });
    }
    return rows.length;
  }

  /** Missions awaiting decomposition get one planning session. */
  private async planMissions(): Promise<number> {
    const pending = await query<{
      id: string; title: string; objective: string;
      acceptance_criteria: string | null; working_dir: string | null;
      agent_slug: string | null; surface_id: string | null;
    }>(
      `SELECT m.id, m.title, m.objective, m.acceptance_criteria, m.working_dir,
              a.slug AS agent_slug, m.origin_surface_id AS surface_id
         FROM missions m
         LEFT JOIN agents a ON a.id = m.owner_agent_id
        WHERE m.status = 'planning'
          AND NOT EXISTS (SELECT 1 FROM mission_steps s WHERE s.mission_id = m.id)
          -- Planning takes minutes and the tick is seconds. Without this the
          -- executor starts a fresh planning session on every pass.
          AND (m.planning_session_id IS NULL
               OR NOT EXISTS (SELECT 1 FROM sessions ps
                               WHERE ps.id = m.planning_session_id
                                 AND ps.status IN ('pending','running','idle')))
          -- And if a planning session already ran and produced nothing, do not
          -- silently loop: let the failure counter trip the circuit breaker.
          AND m.consecutive_failures < m.max_consecutive_failures
        ORDER BY m.created_at
        LIMIT 1`,
    );

    for (const m of pending) {
      const prompt =
        `${PLANNING_PROMPT}\n\n` +
        `# Mission\n${m.title}\n\n` +
        `# Objective (verbatim — this is the contract)\n${m.objective}\n\n` +
        (m.acceptance_criteria ? `# Done when\n${m.acceptance_criteria}\n\n` : '') +
        `# Mission id\n${m.id}\n` +
        (m.working_dir ? `\n# Working directory\n${m.working_dir}\n` : '');

      const result = await this.manager.start({
        agent: m.agent_slug ?? 'simba',
        prompt,
        cwd: m.working_dir ?? undefined,
        surfaceId: m.surface_id,
      });

      if ('error' in result) {
        await this.log(m.id, `planning could not start: ${result.error}`, 'warn');
        continue;
      }
      await query(
        `UPDATE missions
            SET started_at = coalesce(started_at, now()),
                sessions_used = sessions_used + 1,
                planning_session_id = $2,
                -- Counts as a failure until a plan actually lands. A planning
                -- session that produces no steps then trips the breaker
                -- instead of being retried forever.
                consecutive_failures = consecutive_failures + 1,
                updated_at = now()
          WHERE id = $1`,
        [m.id, result.sessionId],
      );
      await this.log(m.id, 'planning session started', 'info');
    }
    return pending.length;
  }

  /** Spawns sessions for runnable steps, one at a time per mission. */
  private async runSteps(maxConcurrent = 2): Promise<number> {
    const running = this.manager.listLive().length;
    if (running >= maxConcurrent) return 0;

    const steps = await query<{
      id: string; mission_id: string; seq: number; title: string;
      instruction: string; kind: string; failures: string | null;
      objective: string; acceptance_criteria: string | null;
      working_dir: string | null; agent_slug: string | null; surface_id: string | null;
      mission_title: string;
    }>(
      `SELECT rs.id, rs.mission_id, rs.seq, rs.title, rs.instruction, rs.kind, rs.failures,
              m.objective, m.acceptance_criteria, m.working_dir, m.title AS mission_title,
              m.origin_surface_id AS surface_id,
              a.slug AS agent_slug
         FROM runnable_steps rs
         JOIN missions m ON m.id = rs.mission_id
         LEFT JOIN agents a ON a.id = m.owner_agent_id
        WHERE NOT EXISTS (
          SELECT 1 FROM mission_steps other
           WHERE other.mission_id = rs.mission_id AND other.status = 'running')
          -- Structural ceiling on how much a single mission can have in flight.
          -- The step-level check above is the intended mechanism; this is the
          -- backstop for whatever bug gets past it next time.
          AND coalesce((SELECT live FROM mission_live_sessions mls
                         WHERE mls.mission_id = rs.mission_id), 0) < m.max_concurrent_sessions
        ORDER BY rs.mission_id, rs.seq
        LIMIT $1`,
      [maxConcurrent - running],
    );

    for (const s of steps) {
      const prompt =
        `You are executing one step of a longer mission, autonomously. Nobody is available to answer questions — decide and proceed.\n\n` +
        `# Mission\n${s.mission_title}\n\n` +
        `# Overall objective\n${s.objective}\n\n` +
        (s.acceptance_criteria ? `# The mission is done when\n${s.acceptance_criteria}\n\n` : '') +
        `# Your step (${s.seq}: ${s.title})\n${s.instruction}\n\n` +
        (s.failures
          ? `# A previous attempt at THIS step failed. Do not repeat these:\n${s.failures}\n\n`
          : '') +
        `# Rules\n` +
        `- Install or configure whatever you need. You have full permissions.\n` +
        `- Verify your own work by running it, not by assuming it worked.\n` +
        `- If you discover the plan is missing a step, add it with mission_add_step rather than doing it silently.\n` +
        `- When finished, call mission_step_complete with the outcome. If you failed, say exactly what you tried so the retry does not repeat it.\n\n` +
        `# Identifiers\nmission_id: ${s.mission_id}\nstep_id: ${s.id}\n`;

      const result = await this.manager.start({
        agent: s.agent_slug ?? 'simba',
        prompt,
        cwd: s.working_dir ?? undefined,
        surfaceId: s.surface_id,
      });

      if ('error' in result) {
        await this.log(s.mission_id, `could not start step "${s.title}": ${result.error}`, 'warn', s.id);
        continue;
      }

      await query(
        `UPDATE mission_steps
            SET status = 'running', session_id = $2, attempts = attempts + 1,
                started_at = coalesce(started_at, now())
          WHERE id = $1`,
        [s.id, result.sessionId],
      );
      await query(
        `UPDATE missions SET sessions_used = sessions_used + 1, updated_at = now() WHERE id = $1`,
        [s.mission_id],
      );
      await this.log(s.mission_id, `started step ${s.seq}: ${s.title}`, 'info', s.id);
    }

    return steps.length;
  }

  /**
   * A mission whose steps are all done moves to verifying, then completed. The
   * distinction matters: "all the work steps ran" and "the objective was met"
   * are different claims, and only the second one is what was asked for.
   */
  private async finishMissions(): Promise<number> {
    const done = await query<{ id: string; title: string }>(
      `UPDATE missions
          SET status = 'completed', completed_at = now(), updated_at = now()
        WHERE status = 'verifying'
          AND NOT EXISTS (SELECT 1 FROM mission_steps s
                           WHERE s.mission_id = missions.id
                             AND s.status NOT IN ('succeeded','skipped'))
        RETURNING id, title`,
    );
    for (const d of done) {
      await this.log(d.id, 'mission complete', 'info');
      await recordEvent({ type: 'mission.completed', message: `"${d.title}" completed` });
    }

    // Every step finished but verification has not been claimed: move to
    // verifying so the mission cannot quietly call itself done.
    await query(
      `UPDATE missions
          SET status = 'verifying', updated_at = now()
        WHERE status = 'running'
          AND EXISTS (SELECT 1 FROM mission_steps s WHERE s.mission_id = missions.id)
          AND NOT EXISTS (SELECT 1 FROM mission_steps s
                           WHERE s.mission_id = missions.id
                             AND s.status IN ('pending','running'))`,
    );

    return done.length;
  }

  /** Cron-cadence missions become runnable again when due. */
  private async wakeScheduled(): Promise<void> {
    await query(
      `UPDATE missions
          SET status = 'running', next_run_at = NULL, consecutive_failures = 0, updated_at = now()
        WHERE cadence = 'scheduled'
          AND status IN ('paused','completed')
          AND next_run_at IS NOT NULL
          AND next_run_at <= now()`,
    );
  }

  async log(
    missionId: string,
    message: string,
    level: 'info' | 'warn' | 'error' = 'info',
    stepId?: string,
  ): Promise<void> {
    await query(
      `INSERT INTO mission_log (mission_id, step_id, level, message) VALUES ($1,$2,$3,$4)`,
      [missionId, stepId ?? null, level, message],
    );
  }
}
