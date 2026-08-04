import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { query, closePool } from '../src/db/index.js';
import { createWorktree, inspectWorktree, releaseWorktree } from '../src/session/worktree.js';

const exec = promisify(execFile);
const git = (cwd: string, args: string[]) => exec('git', args, { cwd, windowsHide: true });

/**
 * Does isolation actually isolate, and does it refuse to destroy work?
 *
 * The second question is the one that matters. A worktree that gets cleaned up
 * whenever a session ends will eventually delete the only copy of something an
 * agent produced while nobody was watching, and that is not a recoverable
 * mistake. So this deliberately dirties one worktree and checks it survives.
 */

const repo = await mkdtemp(join(tmpdir(), 'simba-wt-'));
await git(repo, ['init', '-b', 'main']);
await git(repo, ['config', 'user.email', 'probe@example.com']);
await git(repo, ['config', 'user.name', 'probe']);
await writeFile(join(repo, 'shared.txt'), 'original\n', 'utf8');
await git(repo, ['add', '.']);
await git(repo, ['commit', '-m', 'base']);

// Two sessions must exist as rows: createWorktree writes back to them.
const ids = [randomUUID(), randomUUID()];
const agent = await query<{ id: string }>(`SELECT id FROM agents LIMIT 1`);
const agentId = agent[0]!.id;
for (const id of ids) {
  await query(
    `INSERT INTO sessions (id, agent_id, cli, cwd, status, started_at, last_activity_at)
     VALUES ($1,$2,'probe',$3,'running',now(),now())`,
    [id, agentId, repo],
  );
}

const a = await createWorktree({ repo, agentSlug: 'alpha', sessionId: ids[0]! });
const b = await createWorktree({ repo, agentSlug: 'beta', sessionId: ids[1]! });

console.log('--- creation ---');
console.log('alpha  ', a ? `${a.branch}` : 'FAILED');
console.log('beta   ', b ? `${b.branch}` : 'FAILED');
console.log('distinct dirs:', a && b && a.path !== b.path ? 'yes' : 'NO');

if (!a || !b) {
  await closePool();
  process.exit(1);
}

// Each edits the same filename. Under a shared checkout the second would
// clobber the first; isolated, neither can see the other.
await writeFile(join(a.path, 'shared.txt'), 'written by alpha\n', 'utf8');
await writeFile(join(b.path, 'shared.txt'), 'written by beta\n', 'utf8');

console.log('--- isolation ---');
console.log('alpha sees  ', (await readFile(join(a.path, 'shared.txt'), 'utf8')).trim());
console.log('beta sees   ', (await readFile(join(b.path, 'shared.txt'), 'utf8')).trim());
console.log('origin sees ', (await readFile(join(repo, 'shared.txt'), 'utf8')).trim());
console.log(
  'verdict     ',
  (await readFile(join(repo, 'shared.txt'), 'utf8')).trim() === 'original'
    ? 'origin untouched by either agent'
    : 'LEAKED into the shared checkout',
);

// beta commits its work; alpha leaves it uncommitted. Both must survive.
await git(b.path, ['add', '.']);
await git(b.path, ['commit', '-m', 'beta work']);

console.log('--- release: work must not be destroyed ---');
const ra = await releaseWorktree(ids[0]!, a.path);
const rb = await releaseWorktree(ids[1]!, b.path);
console.log(`alpha (dirty)     removed=${ra.removed} — ${ra.reason}`);
console.log(`beta  (committed) removed=${rb.removed} — ${rb.reason}`);
console.log('alpha dir still present:', existsSync(a.path));
console.log('beta  dir still present:', existsSync(b.path));

// A genuinely clean worktree should be reclaimed.
const c = await createWorktree({ repo, agentSlug: 'gamma', sessionId: ids[0]! });
const rc = c ? await releaseWorktree(ids[0]!, c.path) : null;
console.log('--- release: clean worktree ---');
console.log(`gamma (clean)     removed=${rc?.removed} — ${rc?.reason}`);
console.log('gamma dir gone:', c ? !existsSync(c.path) : 'n/a');

const stateA = await inspectWorktree(a.path);
console.log('alpha still reports dirty:', stateA?.dirty);

// Clean up after itself. The first run of this probe left five worktrees
// behind and deleted the session rows that pointed at them, which is how the
// orphan case got discovered — but leaving litter for the next run is not a
// test strategy. Force-removed because these are throwaway repos.
for (const p of [a.path, b.path, c?.path].filter(Boolean) as string[]) {
  await rm(p, { recursive: true, force: true });
}
await rm(repo, { recursive: true, force: true });
await query(`DELETE FROM sessions WHERE id = ANY($1::uuid[])`, [ids]);
await closePool();
process.exit(0);
