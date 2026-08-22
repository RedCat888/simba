import { query, recordEvent } from '../db/index.js';
import { sampleCommit, pressureLevel } from '../ops/commit-charge.js';
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

  /** When the last pressure event was written, and at what severity. */
  private lastPressureAt = 0;
  private lastPressureLevel: 'ok' | 'warn' | 'critical' = 'ok';

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
             WHERE ms.session_id = s.id AND ms.status = 'running')
          -- A failover child that never produced a token is not "idle waiting
          -- for the user". It is a swap that failed to continue. Reaping it
          -- is how Cursor never got the job after Claude ran out of headroom.
          AND NOT (
            s.swap_count > 0
            AND NOT EXISTS (
              SELECT 1 FROM messages m
               WHERE m.session_id = s.id AND m.role = 'assistant'))`,
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
   * than being discovered when something fails to allocate.
   *
   * This used to watch os.freemem() alone, which cannot see the pressure that
   * actually happens here. During the 17 August incident - Gradle unable to
   * start a JVM, taskkill timing out - physical memory was 40% free, three
   * times above this threshold, while commit sat at 99.99%. The alarm was
   * silent for the entire outage because by its measure nothing was wrong.
   *
   * Still deliberately does not act. The right response to real pressure is to
   * reap idle sessions, which tick() already does on its own schedule, and
   * killing sessions from inside a memory alarm is how a bad reading turns into
   * lost work.
   */
  async checkPressure(): Promise<{ freeMb: number; totalMb: number } | null> {
    const os = await import('node:os');
    const freeMb = Math.round(os.freemem() / 1024 / 1024);
    const totalMb = Math.round(os.totalmem() / 1024 / 1024);
    const commit = await sampleCommit();
    const pressure = pressureLevel(freeMb, totalMb, commit);

    // Throttled, because this runs on every supervisor tick - every fifteen
    // seconds. Unthrottled it produced nineteen near-identical events in one
    // hour on 11 August and eleven on 19 August, into the same feed Today reads
    // for things that need attention. A condition repeated four times a minute
    // stops being a signal.
    //
    // Escalation is exempt: warn becoming critical is new information and
    // should not wait out a window opened by the warning.
    const escalated = pressure.level === 'critical' && this.lastPressureLevel !== 'critical';
    const throttled = Date.now() - this.lastPressureAt < 60 * 60_000;
    if (pressure.level === 'ok') this.lastPressureLevel = 'ok';

    if (pressure.level !== 'ok' && (escalated || !throttled)) {
      this.lastPressureAt = Date.now();
      this.lastPressureLevel = pressure.level;
      await recordEvent({
        type: 'system.memory_pressure',
        severity: pressure.level === 'critical' ? 'critical' : 'warn',
        message: pressure.reason ?? 'memory pressure',
        data: { freeMb, totalMb, commitUsedMb: commit?.usedMb ?? null, commitLimitMb: commit?.limitMb ?? null },
      });
    }
    return { freeMb, totalMb };
  }
}
