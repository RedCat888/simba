import { query, recordEvent } from '../db/index.js';
import type { SessionManager } from '../session/manager.js';

/**
 * Memory hygiene.
 *
 * Every live CLI session holds roughly 300 MB, and a session does not exit when
 * it stops working — it goes idle and waits for input that may never come. On a
 * machine also running Postgres, Ollama and the gateway, a day of use quietly
 * accumulates several gigabytes of processes nobody will ever speak to again.
 *
 * Reaping is safe because the process was never the truth: the transcript is in
 * Postgres and messaging a reaped session transparently revives it. The cost of
 * being wrong is one cold start.
 */

export interface ReapStats {
  idleReaped: number;
  freedEstimateMb: number;
}

export class Reaper {
  constructor(
    private readonly manager: SessionManager,
    /** Idle this long with nobody talking to it, and it is just holding memory. */
    private readonly idleMinutes = Number(process.env.SIMBA_REAP_IDLE_MINUTES ?? 20),
  ) {}

  async tick(): Promise<ReapStats> {
    const stats: ReapStats = { idleReaped: 0, freedEstimateMb: 0 };

    const stale = await query<{ id: string; agent: string; minutes: number }>(
      `SELECT s.id, a.slug AS agent,
              EXTRACT(EPOCH FROM (now() - s.last_activity_at)) / 60 AS minutes
         FROM sessions s
         JOIN agents a ON a.id = s.agent_id
        WHERE s.status = 'idle'
          AND s.last_activity_at < now() - ($1 || ' minutes')::interval
          -- Never reap a session a mission is actively depending on.
          AND NOT EXISTS (
            SELECT 1 FROM mission_steps ms
             WHERE ms.session_id = s.id AND ms.status = 'running')`,
      [String(this.idleMinutes)],
    );

    for (const s of stale) {
      const live = this.manager.getLive(s.id);
      if (!live) {
        // Not attached: nothing to free, just correct the bookkeeping so the
        // roster stops claiming it is available.
        await query(`UPDATE sessions SET status = 'completed' WHERE id = $1`, [s.id]);
        continue;
      }
      await this.manager.kill(s.id);
      stats.idleReaped += 1;
      stats.freedEstimateMb += 300;
    }

    if (stats.idleReaped > 0) {
      await recordEvent({
        type: 'supervisor.reaped_idle',
        message:
          `reaped ${stats.idleReaped} idle session(s) after ${this.idleMinutes}m ` +
          `(~${stats.freedEstimateMb} MB); they revive on next message`,
      });
    }

    return stats;
  }

  /**
   * Reports memory pressure so it lands in the audit log and the brief rather
   * than being discovered when something fails to allocate. Deliberately does
   * not act on it: the correct response to genuine pressure is to reap idle
   * sessions, which the tick above already does on its own schedule.
   */
  async checkPressure(): Promise<{ freeMb: number; totalMb: number } | null> {
    const os = await import('node:os');
    const freeMb = Math.round(os.freemem() / 1024 / 1024);
    const totalMb = Math.round(os.totalmem() / 1024 / 1024);
    const freePct = (freeMb / totalMb) * 100;

    if (freePct < 12) {
      await recordEvent({
        type: 'system.memory_pressure',
        severity: 'warn',
        message: `only ${freeMb} MB free of ${totalMb} MB (${freePct.toFixed(0)}%)`,
        data: { freeMb, totalMb },
      });
    }
    return { freeMb, totalMb };
  }
}
