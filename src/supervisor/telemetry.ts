import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

import { query, recordEvent } from '../db/index.js';

const execFileAsync = promisify(execFile);

/**
 * Machine telemetry.
 *
 * Samples grouped process memory so a leak can be *diagnosed* rather than
 * worked around by restarting. A single snapshot cannot distinguish a process
 * that is large from one that is growing; only a trend can, so the value here
 * is entirely in accumulating history.
 *
 * Uses `tasklist` rather than spawning PowerShell: it is a native binary with
 * CSV output and starts in milliseconds, which matters for something running on
 * every supervisor tick.
 */

interface Grouped {
  claudeDesktop: number;
  claudeCode: number;
  simba: number;
  ollama: number;
  postgres: number;
  otherTop: number;
  count: number;
  top: Array<{ name: string; pid: number; mb: number }>;
}

async function sampleProcesses(): Promise<Grouped | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('tasklist', ['/fo', 'csv', '/nh'], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }));
  } catch {
    return null;
  }

  const g: Grouped = {
    claudeDesktop: 0, claudeCode: 0, simba: 0, ollama: 0,
    postgres: 0, otherTop: 0, count: 0, top: [],
  };
  const all: Array<{ name: string; pid: number; mb: number }> = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // "name","pid","session","session#","mem K"
    const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
    if (cols.length < 5) continue;
    const name = (cols[0] ?? '').toLowerCase();
    const pid = Number(cols[1]);
    const mb = Math.round(Number((cols[4] ?? '0').replace(/[^\d]/g, '')) / 1024);
    if (!Number.isFinite(mb) || mb <= 0) continue;

    g.count += 1;
    all.push({ name, pid, mb });

    // claude.exe covers both the desktop app and the CLI; they are separate
    // concerns and lumping them hides which one is growing.
    if (name === 'claude.exe') g.claudeDesktop += mb;
    else if (name === 'node.exe') g.simba += mb;
    else if (name.startsWith('ollama')) g.ollama += mb;
    else if (name.startsWith('postgres')) g.postgres += mb;
  }

  all.sort((a, b) => b.mb - a.mb);
  g.top = all.slice(0, 10);
  g.otherTop = all
    .filter((p) => !['claude.exe', 'node.exe'].includes(p.name) &&
                   !p.name.startsWith('ollama') && !p.name.startsWith('postgres'))
    .slice(0, 5)
    .reduce((s, p) => s + p.mb, 0);

  return g;
}

/**
 * Commit charge: the ceiling that actually stops things starting.
 *
 * os.freemem() reports free *physical* memory, which is not what an allocation
 * is checked against. Windows checks commit — RAM plus pagefile — and refuses
 * once that is exhausted no matter how much RAM is idle. Measured here at
 * 13 GB physical free and 99.99% commit, where a JVM could not reserve 32 MB.
 *
 * typeperf rather than PowerShell for the same reason tasklist is used above:
 * it is a native binary, and this runs on a supervisor tick.
 */
async function sampleCommit(): Promise<{ usedMb: number; limitMb: number } | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'typeperf',
      ['\\Memory\\Committed Bytes', '\\Memory\\Commit Limit', '-sc', '1'],
      { timeout: 15_000, windowsHide: true },
    ));
  } catch {
    return null;
  }
  // Second line is the sample: "timestamp","committed","limit"
  const row = stdout.split(/\r?\n/).find((l) => /^"\d{2}\/\d{2}\/\d{4}/.test(l));
  if (!row) return null;
  const cols = row.split('","').map((c) => c.replace(/^"|"$/g, ''));
  const used = Number(cols[1]);
  const limit = Number(cols[2]);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return {
    usedMb: Math.round(used / 1024 / 1024),
    limitMb: Math.round(limit / 1024 / 1024),
  };
}

export class Telemetry {
  private lastSample = 0;
  private commitWarnedAt = 0;

  /** Sampled on a slower cadence than the tick; trends do not need seconds. */
  async tick(intervalMs = 5 * 60_000): Promise<void> {
    if (Date.now() - this.lastSample < intervalMs) return;
    this.lastSample = Date.now();

    const [g, commit] = await Promise.all([sampleProcesses(), sampleCommit()]);
    const freeMb = Math.round(os.freemem() / 1024 / 1024);
    const totalMb = Math.round(os.totalmem() / 1024 / 1024);

    await query(
      `INSERT INTO system_samples
         (free_mb, total_mb, claude_desktop_mb, claude_code_mb, simba_mb,
          ollama_mb, postgres_mb, other_top_mb, process_count, detail,
          commit_used_mb, commit_limit_mb)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        freeMb, totalMb,
        g?.claudeDesktop ?? null, null, g?.simba ?? null,
        g?.ollama ?? null, g?.postgres ?? null, g?.otherTop ?? null,
        g?.count ?? null, JSON.stringify({ top: g?.top ?? [] }),
        commit?.usedMb ?? null, commit?.limitMb ?? null,
      ],
    );

    await this.checkCommit(commit);
    await this.detectLeak();
  }

  /**
   * Says so *before* the next session start fails.
   *
   * Starting an agent means starting a CLI process, and a process that cannot
   * be committed fails with whatever error its runtime happens to produce —
   * "_beginthreadex failed (EINVAL)" being the one seen here, which names
   * nothing a reader could act on. An event at 95% turns that into a sentence
   * about the pagefile.
   *
   * Rate-limited to hourly: this condition persists for as long as the machine
   * stays busy, and repeating it every five minutes would bury everything else
   * in the same feed.
   */
  private async checkCommit(commit: { usedMb: number; limitMb: number } | null): Promise<void> {
    if (!commit) return;
    const pct = (commit.usedMb / commit.limitMb) * 100;
    if (pct < 95) return;
    if (Date.now() - this.commitWarnedAt < 60 * 60_000) return;
    this.commitWarnedAt = Date.now();

    const freeMb = commit.limitMb - commit.usedMb;
    await recordEvent({
      type: 'system.commit_pressure',
      message:
        `Memory commit at ${pct.toFixed(1)}% (${freeMb} MB free of ${commit.limitMb} MB). ` +
        `New processes may fail to start even though physical RAM looks free — ` +
        `the fix is a larger pagefile, not closing apps.`,
      data: { usedMb: commit.usedMb, limitMb: commit.limitMb, freeMb, pct: Number(pct.toFixed(1)) },
    });
  }

  /**
   * Flags sustained growth rather than a single large reading.
   *
   * The threshold is deliberately on the *trend*: a renderer sitting at 600 MB
   * is normal, a renderer that has added 600 MB over six hours while free
   * memory fell is a leak. Reporting the former would train the reader to
   * ignore the latter.
   */
  private async detectLeak(): Promise<void> {
    const rows = await query<{
      claude_desktop_delta_mb: number | null;
      free_delta_mb: number | null;
      claude_desktop_now_mb: number | null;
    }>(`SELECT * FROM memory_trend`);

    const t = rows[0];
    if (!t?.claude_desktop_delta_mb) return;

    if (t.claude_desktop_delta_mb > 800 && (t.free_delta_mb ?? 0) < -500) {
      await recordEvent({
        type: 'system.leak_suspected',
        severity: 'warn',
        message:
          `Claude desktop grew ${t.claude_desktop_delta_mb} MB over the sample window ` +
          `(now ${t.claude_desktop_now_mb} MB) while free memory fell ` +
          `${Math.abs(t.free_delta_mb ?? 0)} MB`,
        data: t as unknown as Record<string, unknown>,
      });
    }
  }
}
