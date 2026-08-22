import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The memory ceiling that actually binds on this machine.
 *
 * os.freemem() reports free physical RAM, and allocations are not checked
 * against it. Windows checks commit — RAM plus pagefile — and refuses once that
 * is exhausted no matter how much RAM is sitting idle.
 *
 * On 17 August this machine had 13 GB of 32 GB physically free, which is 40%,
 * and could not reserve 32 MB: Gradle failed to start a JVM, and `tasklist` and
 * `taskkill` timed out. Commit was at 99.99%. Any alarm watching free physical
 * memory reported everything fine throughout, because by its measure everything
 * was.
 *
 * typeperf rather than PowerShell: a native binary, and this runs on a
 * supervisor tick.
 */

export type Commit = { usedMb: number; limitMb: number };

let cached: { at: number; value: Commit | null } | null = null;
let inFlight: Promise<Commit | null> | null = null;

/** How long a reading stays good enough. Commit moves in minutes, not seconds. */
const CACHE_MS = 60_000;

/**
 * Cached and de-duplicated, because two callers on different schedules share it.
 *
 * The reaper checks pressure every supervisor tick - every fifteen seconds - and
 * telemetry samples every five minutes. Each typeperf spawn costs about 1.4s,
 * so calling through on every request meant four process spawns a minute and
 * overlapping invocations that returned null: the first sample after wiring the
 * reaper up came back empty for exactly this reason.
 *
 * A null result is cached too. A failing typeperf fails for a reason that will
 * still be true a second later, and retrying it four times a minute helps
 * nobody.
 */
export async function sampleCommit(): Promise<Commit | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  if (inFlight) return inFlight;
  inFlight = readCommit()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function readCommit(): Promise<Commit | null> {
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
  // The sample is the row starting with a timestamp: "time","committed","limit"
  const row = stdout.split(/\r?\n/).find((l) => /^"\d{2}\/\d{2}\/\d{4}/.test(l));
  if (!row) return null;
  const cols = row.split('","').map((c) => c.replace(/^"|"$/g, ''));
  const used = Number(cols[1]);
  const limit = Number(cols[2]);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return { usedMb: Math.round(used / 1024 / 1024), limitMb: Math.round(limit / 1024 / 1024) };
}

export type Pressure = {
  level: 'ok' | 'warn' | 'critical';
  /** One sentence naming which ceiling is close and what it means. */
  reason: string | null;
};

/**
 * Judges both ceilings, and reports whichever is worse.
 *
 * Commit is deliberately the stricter test. Running out of physical RAM makes
 * the machine slow, which is recoverable and obvious; running out of commit
 * makes it unable to start processes, which is neither. Simba starts a CLI
 * process every time it starts a session, so commit exhaustion is the one that
 * stops it working rather than merely slowing it down.
 *
 * `commit` is optional because typeperf can fail, and a missing reading must
 * not read as a healthy one — it simply falls back to judging RAM alone.
 */
export function pressureLevel(
  freeMb: number,
  totalMb: number,
  commit: Commit | null,
): Pressure {
  if (commit && commit.limitMb > 0) {
    const usedPct = (commit.usedMb / commit.limitMb) * 100;
    const freeCommitMb = commit.limitMb - commit.usedMb;
    if (usedPct >= 95) {
      return {
        level: 'critical',
        reason:
          `memory commit at ${usedPct.toFixed(1)}% (${freeCommitMb} MB free of ${commit.limitMb} MB). ` +
          `New processes may fail to start even though physical RAM looks free - ` +
          `the fix is a larger pagefile, not closing apps.`,
      };
    }
    if (usedPct >= 88) {
      return {
        level: 'warn',
        reason: `memory commit at ${usedPct.toFixed(1)}% (${freeCommitMb} MB free). Starting sessions will fail before RAM runs out.`,
      };
    }
  }

  if (totalMb > 0) {
    const freePct = (freeMb / totalMb) * 100;
    if (freePct < 12) {
      return {
        level: 'warn',
        reason: `only ${freeMb} MB free of ${totalMb} MB (${freePct.toFixed(0)}%)`,
      };
    }
  }

  return { level: 'ok', reason: null };
}
