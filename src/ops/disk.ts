import { statfs } from 'node:fs/promises';

export type DiskSpace = { freeMb: number; totalMb: number };

/**
 * Free space on the volume that matters, which is the one Postgres writes to.
 *
 * Nothing watched this until C: reached zero on 22 August. git failed with "No
 * space left on device" and could not write its own index lock; Postgres was one
 * write away from the same wall, and Postgres is where everything Simba knows
 * lives. Telemetry had free RAM, commit charge and per-process memory every five
 * minutes and nothing to say about the disk.
 *
 * statfs rather than shelling out to PowerShell: it is a syscall, and this runs
 * on a supervisor tick.
 */
export async function sampleDisk(path = process.cwd()): Promise<DiskSpace | null> {
  try {
    const s = await statfs(path);
    return {
      freeMb: Math.round((s.bavail * s.bsize) / 1024 / 1024),
      totalMb: Math.round((s.blocks * s.bsize) / 1024 / 1024),
    };
  } catch {
    return null;
  }
}

export type DiskPressure = { level: 'ok' | 'warn' | 'critical'; reason: string | null };

/**
 * Judged on absolute free space rather than a percentage.
 *
 * A percentage is the wrong unit on a 1.8TB volume: five per cent free is 93GB,
 * which is fine, and on a 256GB volume the same rule fires at 12GB, which is
 * not. What actually matters is whether there is room for the things that need
 * it - a Postgres checkpoint, a Gradle build, a model pull - and those are
 * measured in gigabytes regardless of how large the disk is.
 */
export function diskPressure(disk: DiskSpace | null): DiskPressure {
  if (!disk || disk.totalMb <= 0) return { level: 'ok', reason: null };
  const freeGb = disk.freeMb / 1024;
  if (freeGb < 2) {
    return {
      level: 'critical',
      reason:
        `only ${freeGb.toFixed(1)} GB free on the volume Postgres writes to. ` +
        `Writes are about to start failing - git already cannot write a lock file at this level.`,
    };
  }
  if (freeGb < 10) {
    return {
      level: 'warn',
      reason: `${freeGb.toFixed(1)} GB free on the volume Postgres writes to. A build or a model pull will exhaust this.`,
    };
  }
  return { level: 'ok', reason: null };
}
