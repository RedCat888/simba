import { query, recordEvent } from '../db/index.js';
import { config } from '../config.js';
import type { SessionManager } from '../session/manager.js';
import { releaseWorktree } from '../session/worktree.js';
import { learn } from '../knowledge/learn.js';
import { curate } from '../knowledge/curator.js';
import { cheapComplete } from '../hydration/cheap.js';
import { Router } from '../router/index.js';
import { MissionExecutor } from '../missions/executor.js';
import { generateBrief } from './brief.js';
import { Reaper } from './reaper.js';
import { Telemetry } from './telemetry.js';
import { saveHandoff } from '../tools/handoff.js';

/**
 * The supervisor.
 *
 * Deterministic code with no model in the loop. Everything here is a table
 * lookup or a timer — watching for stalls, resuming work when a subscription's
 * limit resets, delivering queued inter-agent messages, keeping partitions
 * ahead of the clock.
 *
 * This separation is the point: most of what "Simba" appears to do is
 * bookkeeping, and bookkeeping should never cost a token. Simba the agent is
 * the conversational and judgment layer sitting on top of this; the supervisor
 * runs whether or not Simba is thinking.
 */

export class Supervisor {
  /** Curation is hourly; this is when it last ran. */
  private lastCurationAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly router: Router;
  private readonly missions: MissionExecutor;
  private readonly reaper: Reaper;
  private readonly telemetry = new Telemetry();
  private lastHandoff = 0;
  private readonly briefIntervalMinutes = Number(process.env.SIMBA_BRIEF_MINUTES ?? 30);

  constructor(private readonly manager: SessionManager) {
    this.router = new Router(manager);
    this.missions = new MissionExecutor(manager);
    this.reaper = new Reaper(manager);
  }

  /**
   * Rolls session cost up to the missions that caused it. Missions enforce a
   * spend ceiling, and the ceiling is meaningless if the spend is only ever
   * recorded against sessions.
   */
  private async rollUpMissionCost(): Promise<void> {
    await query(
      // Every session the mission ever spent on, including planning and
      // superseded attempts. Joining through mission_steps counted only the
      // session each step currently points at, so planning cost and every
      // retry vanished - and the budget ceiling is enforced against this
      // number, which made it the wrong number in the direction that matters.
      `UPDATE missions m
          SET cost_used_usd = sub.total, updated_at = now()
         FROM (
           SELECT s.mission_id, coalesce(sum(s.total_cost_usd), 0) AS total
             FROM sessions s
            WHERE s.mission_id IS NOT NULL
            GROUP BY s.mission_id
         ) sub
        WHERE m.id = sub.mission_id AND m.cost_used_usd <> sub.total`,
    );
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), config.supervisor.tickMs);
    void this.tick();
    console.log(`[supervisor] started, tick=${config.supervisor.tickMs}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.clearExpiredLimits();
      await this.resumeAfterReset();
      await this.detectStalls();
      await this.router.tick();
      await this.missions.tick();
      await this.reaper.tick();
      await this.reaper.checkPressure();
      await this.telemetry.tick();
      await this.maintain();

      // Regenerated periodically so a session that dies unexpectedly still
      // leaves a current handoff behind rather than one from hours ago.
      if (Date.now() - this.lastHandoff > 15 * 60_000) {
        this.lastHandoff = Date.now();
        await saveHandoff().catch(() => {});
      }
      await this.titleUntitledSessions();
      await this.reclaimCleanWorktrees();
      await this.harvestLessons();

      // Curation is hourly, not per-tick. Neither store changes fast enough to
      // justify a model call every fifteen seconds, and consolidation is the
      // one operation here that rewrites rather than adds.
      if (Date.now() - this.lastCurationAt > 60 * 60_000) {
        this.lastCurationAt = Date.now();
        const result = await curate();
        if (result.notes.length > 0) {
          console.log('[curator]', result.notes.slice(0, 5).join(' | '));
        }
      }
      await this.rollUpMissionCost();
      await generateBrief(this.briefIntervalMinutes);
    } catch (err) {
      console.error('[supervisor] tick failed', err);
    } finally {
      this.running = false;
    }
  }

  /** A limited brain becomes available again the moment its reset time passes. */
  private async clearExpiredLimits(): Promise<void> {
    const rows = await query<{ slug: string }>(
      `UPDATE brain_accounts
          SET status = 'available', limit_resets_at = NULL, updated_at = now()
        WHERE status = 'limited'
          AND limit_resets_at IS NOT NULL
          AND limit_resets_at <= now()
        RETURNING slug`,
    );
    for (const r of rows) {
      await recordEvent({
        type: 'brain.limit_cleared',
        message: `${r.slug} is available again`,
      });
    }
  }

  /**
   * Sessions parked because every brain was exhausted. Once any brain is usable
   * the work resumes on its own — this is the "wait until limits reset and pick
   * back up" behaviour, driven off the reset timestamp the CLI reported rather
   * than a guess.
   */
  private async resumeAfterReset(): Promise<void> {
    const available = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM brain_accounts
        WHERE enabled AND status = 'available'`,
    );
    if ((available[0]?.n ?? 0) === 0) return;

    const parked = await query<{
      id: string; agent_id: string; agent_slug: string;
      cwd: string | null; worktree_path: string | null; origin_surface_id: string | null;
    }>(
      `SELECT s.id, s.agent_id, a.slug AS agent_slug, s.cwd, s.worktree_path, s.origin_surface_id
         FROM sessions s
         JOIN agents a ON a.id = s.agent_id
        WHERE s.status = 'waiting_limit'
        ORDER BY s.last_activity_at
        LIMIT 3`,
    );

    for (const p of parked) {
      await recordEvent({
        type: 'session.resuming_after_reset',
        sessionId: p.id,
        agentId: p.agent_id,
        message: 'a brain became available; resuming parked work',
      });

      const result = await this.manager.start({
        agent: p.agent_slug,
        continuingSessionId: p.id,
      // worktree_path first: an isolated session's work lives there, not in cwd.
      // Resuming from cwd silently drops it — the continuation starts in the
      // shared checkout without the changes, while the only copy stays stranded
      // in a worktree nothing points at any more. That is the one failure mode
      // worktrees were introduced to prevent.
        cwd: p.worktree_path ?? p.cwd ?? undefined,
        // Carried through, or the resumed session comes back with a NULL
        // surface. Combined with the MCP action check, that meant a
        // phone-originated task could hit a usage limit and be auto-resumed by
        // the supervisor with unbounded action authority.
        surfaceId: p.origin_surface_id,
        prompt: 'Your previous session was paused because every brain hit its usage limit. Resume from your brief.',
      });

      if ('sessionId' in result) {
        await query(`UPDATE sessions SET status = 'superseded' WHERE id = $1`, [p.id]);
        await query(`UPDATE agents SET status = 'running' WHERE id = $1`, [p.agent_id]);
      }
    }
  }

  /** A running session with no activity for too long has probably died quietly. */
  private async detectStalls(): Promise<void> {
    const stalled = await query<{ id: string; agent_id: string; last_activity_at: Date }>(
      `SELECT id, agent_id, last_activity_at
         FROM sessions
        WHERE status = 'running'
          AND last_activity_at < now() - ($1 || ' milliseconds')::interval`,
      [String(config.supervisor.stallMs)],
    );

    for (const s of stalled) {
      const live = this.manager.getLive(s.id);
      if (live) continue; // still attached; slow, not stalled

      await query(`UPDATE sessions SET status = 'failed', error = 'stalled' WHERE id = $1`, [s.id]);
      await query(`UPDATE agents SET status = 'idle' WHERE id = $1`, [s.agent_id]);
      await recordEvent({
        type: 'session.stalled',
        severity: 'warn',
        sessionId: s.id,
        agentId: s.agent_id,
        message: `no activity since ${s.last_activity_at?.toISOString?.() ?? 'unknown'}; marked failed`,
      });
    }
  }

  /** Keep partitions ahead of the clock so inserts never land in DEFAULT. */
  private async maintain(): Promise<void> {
    await query(`SELECT ensure_partitions(3)`);
  }

  /**
   * Auto-titling. Explicitly a cheap-model job: four hundred untitled sessions
   * is the failure mode this prevents, and none of it warrants a real brain.
   */
  private async titleUntitledSessions(): Promise<void> {
    const rows = await query<{ id: string; agent_id: string }>(
      `SELECT s.id, s.agent_id
         FROM sessions s
        WHERE s.title IS NULL
          AND s.status IN ('completed','idle','failed','superseded')
          AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
        ORDER BY s.created_at DESC
        LIMIT 2`,
    );

    for (const r of rows) {
      const messages = await query<{ role: string; content: string | null }>(
        `SELECT role, content FROM messages
          WHERE session_id = $1 AND content IS NOT NULL AND content <> ''
          ORDER BY seq LIMIT 25`,
        [r.id],
      );
      if (messages.length === 0) continue;

      const transcript = messages
        .map((m) => `[${m.role}] ${(m.content ?? '').slice(0, 600)}`)
        .join('\n');

      const out = await cheapComplete(
        `Summarize this agent session. Return ONLY JSON with keys: ` +
          `"title" (max 8 words), "description" (one sentence), "tags" (array of 2-5 short lowercase strings).\n\n${transcript}`,
      );
      if (!out) continue;

      try {
        const start = out.indexOf('{');
        const end = out.lastIndexOf('}');
        if (start === -1 || end <= start) continue;
        const parsed = JSON.parse(out.slice(start, end + 1)) as {
          title?: string;
          description?: string;
          tags?: string[];
        };

        await query(
          `UPDATE sessions SET title = $2, description = $3, tags = $4 WHERE id = $1`,
          [r.id, parsed.title ?? null, parsed.description ?? null, parsed.tags ?? []],
        );
        await query(
          `INSERT INTO summaries (scope, session_id, agent_id, title, description, tags, summary, model)
           VALUES ('session', $1, $2, $3, $4, $5, $6, 'cheap')`,
          [
            r.id,
            r.agent_id,
            parsed.title ?? null,
            parsed.description ?? null,
            parsed.tags ?? [],
            parsed.description ?? null,
          ],
        );
      } catch {
        // A malformed summary is not worth retrying or logging loudly; the next
        // tick will pick the session up again.
      }
    }
  }

  /**
   * Give back isolated checkouts that hold nothing.
   *
   * releaseWorktree was written with the isolation feature and then never
   * called by anything, so worktrees accumulated indefinitely — four had piled
   * up before this was noticed. Every one was clean, which is why nothing
   * surfaced them: /api/worktrees deliberately reports only checkouts holding
   * uncollected work, so empty ones were invisible *and* immortal.
   *
   * Safe by construction rather than by care: releaseWorktree refuses to remove
   * anything dirty or holding commits no other branch has, so this can only
   * ever reclaim directories with nothing in them. Sessions still live are
   * excluded before it is asked.
   */
  private async reclaimCleanWorktrees(): Promise<void> {
    const candidates = await query<{ id: string; worktree_path: string }>(
      `SELECT id, worktree_path FROM sessions
        WHERE worktree_path IS NOT NULL
          AND status NOT IN ('running', 'idle', 'pending')`,
    );

    for (const c of candidates) {
      if (this.manager.getLive(c.id)) continue;
      const result = await releaseWorktree(c.id, c.worktree_path);
      if (!result.removed) continue;
      await recordEvent({
        type: 'worktree.reclaimed',
        severity: 'debug',
        sessionId: c.id,
        message: `${c.worktree_path}: ${result.reason}`,
      });
    }
  }

  /**
   * Distil finished work into skills, without being asked.
   *
   * /learn covers the deliberate case. This covers the one that matters: a
   * store that fills only when someone remembers to invoke it stays roughly as
   * empty as it shipped.
   *
   * The signal is a session that *struggled and then succeeded*. Tool failures
   * followed by a completed session is where the lesson lives — a run that
   * worked first time teaches nothing worth writing down, and one that failed
   * outright has no working procedure to record. Near-silent sessions are
   * skipped for the same reason.
   *
   * One per tick, on the free tier. Learning that competes with real work for
   * concurrency or subscription headroom is learning that gets switched off,
   * and there is no hurry — the sessions are already finished.
   */
  private async harvestLessons(): Promise<number> {
    const candidates = await query<{ id: string; agent: string; failures: number; calls: number }>(
      `SELECT s.id, a.slug AS agent,
              count(*) FILTER (WHERE t.is_error)::int AS failures,
              count(t.id)::int AS calls
         FROM sessions s
         JOIN agents a ON a.id = s.agent_id
         LEFT JOIN tool_calls t ON t.session_id = s.id
        WHERE s.learned_at IS NULL
          AND s.status IN ('completed','idle')
          -- Settled: a session that ended seconds ago may still be being
          -- written to, and half a transcript distils into half a lesson.
          AND s.last_activity_at < now() - interval '3 minutes'
        GROUP BY s.id, a.slug
       HAVING count(*) FILTER (WHERE t.is_error) > 0
          AND count(t.id) >= 5
        ORDER BY count(*) FILTER (WHERE t.is_error) DESC
        LIMIT 1`,
    );

    let learned = 0;
    for (const c of candidates) {
      // Marked before the attempt, not after. Distillation can fail, and
      // retrying the same session every fifteen seconds forever is worse than
      // missing one lesson.
      await query(`UPDATE sessions SET learned_at = now() WHERE id = $1`, [c.id]);

      const result = await learn({ from: 'session', sessionId: c.id });
      if (result.learned) {
        learned += 1;
        await recordEvent({
          type: 'skill.learned',
          severity: 'info',
          sessionId: c.id,
          message: `learned "${result.name}" from ${c.agent} (${c.failures} failures, ${c.calls} tool calls)`,
          data: { skill: result.name, created: result.created },
        });
      } else {
        await recordEvent({
          type: 'skill.not_learned',
          severity: 'debug',
          sessionId: c.id,
          message: `nothing reusable in ${c.agent} session: ${result.reason ?? 'unknown'}`,
        });
      }
    }
    return learned;
  }


}
