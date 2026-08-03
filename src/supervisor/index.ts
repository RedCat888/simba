import { query, recordEvent } from '../db/index.js';
import { config } from '../config.js';
import type { SessionManager } from '../session/manager.js';
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
      `UPDATE missions m
          SET cost_used_usd = sub.total, updated_at = now()
         FROM (
           SELECT st.mission_id, coalesce(sum(s.total_cost_usd), 0) AS total
             FROM mission_steps st
             JOIN sessions s ON s.id = st.session_id
            GROUP BY st.mission_id
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
      cwd: string | null; origin_surface_id: string | null;
    }>(
      `SELECT s.id, s.agent_id, a.slug AS agent_slug, s.cwd, s.origin_surface_id
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
        cwd: p.cwd ?? undefined,
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
}
