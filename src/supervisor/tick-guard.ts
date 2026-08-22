/**
 * Whether a scheduled tick should run, skip, or force its way past a stuck one.
 *
 * Split out from the Supervisor so it can be tested without a database, and
 * because the rule it encodes is worth stating on its own: a reentrancy guard
 * must not be able to become a permanent stop.
 *
 * The bug it exists for: `finally` never runs for a promise that never settles,
 * so one hung await left `running` true and every later tick returned
 * immediately. Telemetry has a 37-hour hole from it — 20 August 13:16 to
 * 22 August 01:56 — while the gateway served HTTP normally the whole time.
 */

export type TickDecision = 'run' | 'skip' | 'forced';

/**
 * `forced` means the in-flight tick is presumed lost, not merely slow.
 *
 * cheapComplete tries up to four backends at 90s each, so several minutes is a
 * legitimately slow tick rather than a broken one; the threshold sits above
 * that. Overlapping with a hung tick is strictly better than joining it
 * forever.
 */
export function tickDecision(
  running: boolean,
  runningSince: number,
  now: number,
  wedgeMs: number,
): TickDecision {
  if (!running) return 'run';
  return now - runningSince >= wedgeMs ? 'forced' : 'skip';
}
