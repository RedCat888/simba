/**
 * A mission whose remaining steps can never run should be blocked, not left
 * looking healthy while doing nothing.
 *
 * runnable_steps requires every dependency to be 'succeeded', so a skipped,
 * failed or blocked prerequisite holds its dependents pending forever. That is
 * the right call - running a step whose prerequisite never happened can do real
 * damage - but doing it silently is not. Before this, such a mission stayed
 * 'running' with nothing in flight, no budget exceeded, and no event.
 *
 * Safe to run: max_concurrent_sessions is 0 so nothing can be launched, and the
 * mission and its steps are removed in a finally.
 *
 *   npx tsx scripts/probe-mission-deadlock.ts
 */
import { MissionExecutor } from '../src/missions/executor.js';
import { query, one, closePool } from '../src/db/index.js';

const SLUG = 'probe-deadlock';
let failures = 0;

try {
  await query(`DELETE FROM missions WHERE slug = $1`, [SLUG]);
  const m = await one<{ id: string }>(
    `INSERT INTO missions (slug, title, objective, status, working_dir,
                           max_sessions, max_cost_usd, max_concurrent_sessions)
     VALUES ($1,'probe deadlock','probe','running','C:\Users\operator\simba',99,99,0)
     RETURNING id`, [SLUG]);
  const id = m!.id;

  // Step 1 skipped; step 2 depends on it and can therefore never become runnable.
  await query(`INSERT INTO mission_steps (mission_id, seq, title, instruction, status)
               VALUES ($1,1,'prerequisite','x','skipped')`, [id]);
  await query(`INSERT INTO mission_steps (mission_id, seq, title, instruction, status, depends_on)
               VALUES ($1,2,'dependent','y','pending','{1}')`, [id]);

  const before = await one<{ status: string }>(`SELECT status FROM missions WHERE id=$1`, [id]);
  console.log(`  before tick : ${before!.status}`);

  const executor = new MissionExecutor({ listLive: () => [], getLive: () => undefined } as never);
  await executor.tick();

  const after = await one<{ status: string; blocked_reason: string | null }>(
    `SELECT status, blocked_reason FROM missions WHERE id=$1`, [id]);
  console.log(`  after tick  : ${after!.status}  ${after!.blocked_reason ?? ''}`);

  const ok = after!.status === 'blocked' && /deadlocked/.test(after!.blocked_reason ?? '');
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  deadlocked mission is blocked with a reason`);

  // A mission that still has a runnable step must NOT be flagged.
  await query(`UPDATE mission_steps SET depends_on='{}' WHERE mission_id=$1 AND seq=2`, [id]);
  await query(`UPDATE missions SET status='running', blocked_reason=NULL WHERE id=$1`, [id]);
  await executor.tick();
  const after2 = await one<{ status: string }>(`SELECT status FROM missions WHERE id=$1`, [id]);
  const ok2 = after2!.status === 'running';
  if (!ok2) failures += 1;
  console.log(`  ${ok2 ? 'PASS' : 'FAIL'}  a mission with work left is untouched (got ${after2!.status})`);
} finally {
  const del = await query<{ id: string }>(`DELETE FROM missions WHERE slug=$1 RETURNING id`, [SLUG]);
  console.log(`  cleaned ${del.length} mission(s); failures=${failures}`);
  await closePool();
}
