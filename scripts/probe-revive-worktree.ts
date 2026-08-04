import { writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { query, one, closePool } from '../src/db/index.js';
import { createWorktree } from '../src/session/worktree.js';

/**
 * Does a revived session come back to its own worktree?
 *
 * An external audit found revival selected `cwd` and not `worktree_path`, so an
 * isolated session that was reaped, parked or restarted resumed in the shared
 * checkout — without its changes, while the only copy of the work stayed
 * stranded in a worktree nothing referenced any more. That is precisely the
 * loss worktrees exist to prevent, arriving through the recovery path.
 *
 * This checks the query, not the launch: whether the row revival reads carries
 * the worktree, and whether the directory it would choose is the isolated one.
 */
const repo = mkdtempSync(join(tmpdir(), 'simba-rev-'));
const git = (args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'p@l']);
git(['config', 'user.name', 'p']);
writeFileSync(join(repo, 'base.txt'), 'base\n');
git(['add', '-A']);
git(['commit', '-qm', 'base']);

const agent = await query<{ id: string }>(`SELECT id FROM agents LIMIT 1`);
const sessionId = randomUUID();
await query(
  `INSERT INTO sessions (id, agent_id, cli, cwd, status, started_at, last_activity_at)
   VALUES ($1,$2,'probe',$3,'running',now(),now())`,
  [sessionId, agent[0]!.id, repo],
);

const wt = await createWorktree({ repo, agentSlug: 'revive', sessionId });
if (!wt) throw new Error('worktree not created');
// Work that exists only in the isolated checkout.
writeFileSync(join(wt.path, 'only-here.txt'), 'work nobody has collected\n');

// Exactly the query revival runs.
const row = await one<{ cwd: string | null; worktree_path: string | null }>(
  `SELECT agent_id, cwd, worktree_path, native_session_id, brain_account_id, swap_count
     FROM sessions WHERE id = $1`,
  [sessionId],
);

const chosen = row?.worktree_path ?? row?.cwd ?? null;
console.log('cwd            ', row?.cwd);
console.log('worktree_path  ', row?.worktree_path);
console.log('revival uses   ', chosen);
console.log(
  'verdict        ',
  chosen === wt.path ? 'resumes in its worktree — work preserved' : 'ABANDONS THE WORKTREE',
);

await query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
await closePool();
process.exit(0);
