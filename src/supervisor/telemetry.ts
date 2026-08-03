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

export class Telemetry {
  private lastSample = 0;

  /** Sampled on a slower cadence than the tick; trends do not need seconds. */
  async tick(intervalMs = 5 * 60_000): Promise<void> {
    if (Date.now() - this.lastSample < intervalMs) return;
    this.lastSample = Date.now();

    const g = await sampleProcesses();
    const freeMb = Math.round(os.freemem() / 1024 / 1024);
    const totalMb = Math.round(os.totalmem() / 1024 / 1024);

    await query(
      `INSERT INTO system_samples
         (free_mb, total_mb, claude_desktop_mb, claude_code_mb, simba_mb,
          ollama_mb, postgres_mb, other_top_mb, process_count, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        freeMb, totalMb,
        g?.claudeDesktop ?? null, null, g?.simba ?? null,
        g?.ollama ?? null, g?.postgres ?? null, g?.otherTop ?? null,
        g?.count ?? null, JSON.stringify({ top: g?.top ?? [] }),
      ],
    );

    await this.detectLeak();
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
