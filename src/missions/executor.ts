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

    await this.reapFinishedStepSessions();
    stats.reopened += await this.reopenOrphanedSteps();
    stats.blocked += await this.enforceBudgets();
    stats.planned += await this.planMissions();
    stats.started += await this.runSteps();
    stats.completed += await this.finishMissions();
    await this.wakeScheduled();

    return stats;
  }

  /**
   * Kills the session behind a step that has finished.
   *
   * A CLI session does not exit when it stops working — it goes idle and waits
   * for more input. That is correct for a conversation and wrong for a mission
   * step: the step is done, the process will never be spoken to again, and it
   * holds a concurrency slot indefinitely. Without this the executor completes
   * step one and then waits forever, which looks exactly like a hang.
   */
  private async reapFinishedStepSessions(): Promise<void> {
    const finished = await query<{ session_id: string; seq: number; mission_id: string }>(
      `SELECT st.session_id, st.seq, st.mission_id
         FROM mission_steps st
         JOIN sessions s ON s.id = st.session_id
        WHERE st.status IN ('succeeded','failed','skipped')
          AND s.status IN ('running','idle','pending')`,
    );

    for (const f of finished) {
      await this.manager.kill(f.session_id);
      await this.log(f.mission_id, `released session for finished step ${f.seq}`, 'info');
    }
  }

  /**
   * A step marked running whose session is gone — killed by a limit, a crash,
   * or a restart. This is the single most important behaviour in the class: it
   * is what lets a mission survive everything that can interrupt it.
   */
  private async reopenOrphanedSteps(): Promise<number> {
    const orphans = await query<{
      id: string;
      mission_id: string;
      title: string;
      session_id: string | null;
      successor_id: string | null;
    }>(
      `SELECT s.id, s.mission_id, s.title, s.session_id,
              -- A superseded session has a continuation: failover started a new
              -- session and left the step pointing at the old one. Requeueing
              -- then runs the step a second time alongside the continuation
              -- already doing it. Finding the successor is what tells the two
              -- cases apart.
              (SELECT n.id FROM sessions n
                WHERE n.hydrated_from_session_id = s.session_id
                ORDER BY n.created_at DESC LIMIT 1) AS successor_id
         FROM mission_steps s
         LEFT JOIN sessions ss ON ss.id = s.session_id
        WHERE s.status = 'running'
          AND (ss.id IS NULL OR ss.status IN ('failed','killed','completed','superseded'))`,
    );

    for (const o of orphans) {
      // Compare against the step's recorded session, not the step's own id.
      // These are both UUIDs so the mistake typechecks, and it meant the guard
      // never matched anything: a step whose session was still live could be
      // requeued underneath itself.
      const live = o.session_id
        ? this.manager.listLive().some((l) => l.sessionId === o.session_id)
        : false;
      if (live) continue;

      // Failover already restarted this work. Adopt the continuation instead of
      // starting a third attempt — otherwise the step runs twice concurrently,
      // which for anything with an external effect is the expensive kind of bug.
      if (o.successor_id) {
        const successorLive = this.manager
          .listLive()
          .some((l) => l.sessionId === o.successor_id);
        if (successorLive) {
          await query(`UPDATE mission_steps SET session_id = $2 WHERE id = $1`, [
            o.id,
            o.successor_id,
          ]);
          await this.log(
            o.mission_id,
            `step "${o.title}" failed over; following the continuation instead of requeueing`,
            'info',
            o.id,
          );
          continue;
        }
      }

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

      // Bind the session to the mission permanently. planning_session_id is
      // cleared once the plan lands, so without this the cost of planning -
      // which can be the most expensive part - disappears from the mission's
      // total and from the budget it is enforced against.
      await query(`UPDATE sessions SET mission_id = $2 WHERE id = $1`, [
        result.sessionId,
        m.id,
      ]);
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
    // Counts steps actually executing, not live processes. An idle session left
    // over from earlier conversational work is not mission capacity, and
    // counting it starves missions on a machine that has been used at all.
    const [busy] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mission_steps WHERE status = 'running'`,
    );
    const running = busy?.n ?? 0;
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

      // Same reasoning: a requeue clears the step's session_id and the next
      // attempt overwrites it, so attempts that failed would otherwise cost
      // nothing as far as the ceiling is concerned.
      await query(`UPDATE sessions SET mission_id = $2 WHERE id = $1`, [
        result.sessionId,
        s.mission_id,
      ]);

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
    //
    // Failed steps are excluded deliberately. Without that exclusion a mission
    // with one failed step moved to verifying and could never leave: completion
    // requires every step succeeded or skipped, and budget and circuit-breaker
    // enforcement only examine 'running' missions. It was neither retried, nor
    // failed, nor blocked - just silently stuck, which is the worst state for
    // something meant to run unattended.
    await query(
      `UPDATE missions
          SET status = 'verifying', updated_at = now()
        WHERE status = 'running'
          AND EXISTS (SELECT 1 FROM mission_steps s WHERE s.mission_id = missions.id)
          AND NOT EXISTS (SELECT 1 FROM mission_steps s
                           WHERE s.mission_id = missions.id
                             AND s.status IN ('pending','running','failed'))`,
    );

    // A mission whose remaining work is all failed is blocked, and says so.
    //
    // Blocked rather than failed: the steps that succeeded still stand, the
    // retry action already requeues failed steps, and the app surfaces
    // blocked_reason with the reason attached. Calling the whole mission failed
    // would throw away work that was fine.
    const stalled = await query<{ id: string; title: string; failed: string }>(
      `UPDATE missions m
          SET status = 'blocked',
              blocked_reason = sub.reason,
              updated_at = now()
         FROM (
           SELECT s.mission_id,
                  'step(s) failed: ' || string_agg(s.seq || ' "' || s.title || '"', ', '
                                                   ORDER BY s.seq) AS reason,
                  string_agg(s.seq::text, ',' ORDER BY s.seq) AS seqs
             FROM mission_steps s
            WHERE s.status = 'failed'
            GROUP BY s.mission_id
         ) sub
        WHERE m.id = sub.mission_id
          AND m.status IN ('running','verifying')
          AND NOT EXISTS (SELECT 1 FROM mission_steps s2
                           WHERE s2.mission_id = m.id
                             AND s2.status IN ('pending','running'))
        RETURNING m.id, m.title, sub.seqs AS failed`,
    );

    for (const st of stalled) {
      await this.log(st.id, `blocked: step(s) ${st.failed} failed and nothing is left to run`, 'error');
      await recordEvent({
        type: 'mission.blocked',
        severity: 'warn',
        message: `"${st.title}" blocked on failed step(s) ${st.failed}`,
        data: { missionId: st.id, failedSteps: st.failed },
      });
    }

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
