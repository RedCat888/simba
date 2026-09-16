import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, readdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../config.js';
import { query, recordEvent } from '../db/index.js';
import { confine } from '../inventory/files.js';

const execFileAsync = promisify(execFile);

/**
 * Per-session git worktrees.
 *
 * `worktree_path` was read in five places and written by nothing, and the Claude
 * runner advertised a `worktree` capability that did not exist. So every agent
 * shared one working directory: two running at once edit the same files, and
 * the first thing a second agent does is silently invalidate whatever the first
 * has half-finished. That is the blocker for running a team of agents at all,
 * which is the point of the system.
 *
 * A worktree gives each session its own checkout and its own branch off the
 * same repository. They are cheap — git shares the object store, so this costs
 * a checkout rather than a clone.
 *
 * The removal rule is the important part: a worktree is only deleted when it is
 * clean. An agent that produced uncommitted work keeps its directory even after
 * the session ends, because the entire purpose of unattended work is that
 * nobody was watching, and destroying it on the assumption it was worthless is
 * not a recoverable mistake.
 */

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

async function gitQuiet(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

export interface Worktree {
  path: string;
  branch: string;
  /** The repository this was carved from. */
  origin: string;
}

/** Branch names must survive being a path segment and a git ref. */
function branchNameFor(agentSlug: string, sessionId: string): string {
  const safe = agentSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `simba/${safe}/${sessionId.slice(0, 8)}`;
}

/**
 * Creates an isolated checkout for a session, or returns null when the target
 * is not a git repository — in which case the caller keeps the shared cwd,
 * because isolation that silently does nothing is worse than none.
 */
export async function createWorktree(opts: {
  repo: string;
  agentSlug: string;
  sessionId: string;
  /** Branch to start from. Defaults to whatever the repo has checked out. */
  base?: string | null;
}): Promise<Worktree | null> {
  const inRepo = await gitQuiet(opts.repo, ['rev-parse', '--is-inside-work-tree']);
  if (inRepo !== 'true') return null;

  // The real repository root, not wherever inside it the caller happened to be.
  const root = (await gitQuiet(opts.repo, ['rev-parse', '--show-toplevel'])) ?? opts.repo;
  const branch = branchNameFor(opts.agentSlug, opts.sessionId);
  const path = join(config.paths.worktrees, `${opts.agentSlug}-${opts.sessionId.slice(0, 8)}`);

  await mkdir(config.paths.worktrees, { recursive: true });

  if (existsSync(path)) {
    // A previous attempt for this same session. Reuse rather than fail: the
    // session id is the identity, so a second call is a retry, not a new agent.
    return { path, branch, origin: root };
  }

  const base =
    opts.base ?? (await gitQuiet(root, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? 'HEAD';

  try {
    await git(root, ['worktree', 'add', '-b', branch, path, base]);
  } catch (err) {
    // A leftover branch from an earlier run with the same session prefix will
    // collide. Attaching to it is right: it is this session's own branch.
    const detail = err instanceof Error ? err.message : String(err);
    if (/already exists/i.test(detail)) {
      const attached = await gitQuiet(root, ['worktree', 'add', path, branch]);
      if (attached === null) {
        await recordEvent({
          type: 'worktree.failed',
          severity: 'warn',
          sessionId: opts.sessionId,
          message: `could not create worktree for ${opts.agentSlug}: ${detail.slice(0, 300)}`,
        });
        return null;
      }
    } else {
      await recordEvent({
        type: 'worktree.failed',
        severity: 'warn',
        sessionId: opts.sessionId,
        message: `could not create worktree for ${opts.agentSlug}: ${detail.slice(0, 300)}`,
      });
      return null;
    }
  }

  await query(`UPDATE sessions SET worktree_path = $2, branch = $3 WHERE id = $1`, [
    opts.sessionId,
    path,
    branch,
  ]);

  await recordEvent({
    type: 'worktree.created',
    severity: 'info',
    sessionId: opts.sessionId,
    message: `isolated checkout at ${path} on ${branch}`,
    data: { path, branch, base, origin: root },
  });

  return { path, branch, origin: root };
}

export interface WorktreeState {
  path: string;
  branch: string | null;
  dirty: boolean;
  ahead: number;
  /**
   * The repository this was carved from no longer exists.
   *
   * A distinct state, and worth separating from ordinary uncollected work: the
   * changes cannot be merged, diffed against anything, or recovered, because
   * there is nothing left to merge them into. Listing it beside real pending
   * work would overstate it and train the reader to ignore the section.
   */
  originMissing: boolean;
}

/**
 * Two paths naming the same place.
 *
 * git answers in forward slashes regardless of platform, and Windows adds case
 * insensitivity and the occasional trailing separator. Comparing the raw
 * strings would make every worktree on this machine look like a stale
 * directory, which fails in the opposite and more dangerous direction: real
 * uncollected work reported as nothing to collect.
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) =>
    p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The commit every *other* checkout of this repository is sitting on.
 *
 * `git worktree list --porcelain` emits a stanza per checkout, blank-line
 * separated, each starting `worktree <path>` and carrying `HEAD <sha>`. The
 * main repository is one of those stanzas, which is the one that matters here —
 * it is usually the thing holding the commits a session worktree appears to own.
 *
 * Returns SHAs rather than refs so a detached HEAD counts too.
 */
async function headsOfOtherWorktrees(path: string): Promise<string[]> {
  const out = await gitQuiet(path, ['worktree', 'list', '--porcelain']);
  if (!out) return [];

  const here = path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const heads: string[] = [];
  let current: string | null = null;

  for (const line of out.split('\n')) {
    const text = line.trim();
    if (text.startsWith('worktree ')) {
      current = text.slice('worktree '.length).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    } else if (text.startsWith('HEAD ') && current && current !== here) {
      heads.push(text.slice('HEAD '.length));
    }
  }
  return heads;
}

/** Whether a worktree still holds work nobody has collected. */
export async function inspectWorktree(path: string): Promise<WorktreeState | null> {
  if (!existsSync(path)) return null;

  // The directory existing is not the same as it being a checkout.
  //
  // Every git command here runs with -C <path>, and git walks *up* from there
  // when the directory is not a repository root. A leftover empty folder under
  // var/worktrees therefore answers every question with the main repository's
  // state — its branch, its commit count, its uncommitted files — and the
  // result is a worktree that appears to be holding work it does not have and
  // cannot have, because there is nothing in it at all.
  //
  // That is exactly what happened: two empty directories left behind by pruned
  // worktrees reported forty-nine unmerged commits for days, which were simply
  // master's commits seen through them. A warning about unrecoverable work that
  // is always on is worse than no warning, because the one time it is real it
  // reads the same as every false one before it.
  const top = await gitQuiet(path, ['rev-parse', '--show-toplevel']);
  if (!top || !samePath(top, path)) return null;

  const [branch, status] = await Promise.all([
    gitQuiet(path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitQuiet(path, ['status', '--porcelain']),
  ]);

  // "Commits that exist only on this branch" — nothing else answers the actual
  // question, which is whether discarding this worktree would lose anything.
  //
  // Two obvious formulations are both wrong here. `@{upstream}..HEAD` fails
  // outright because a session branch has no upstream. `HEAD --not --remotes`
  // was the first fallback and counts every commit in a repository that has no
  // remote at all, so a freshly created worktree reported one unmerged commit
  // and could never be reclaimed. Excluding this branch from `--branches` asks
  // whether any *other* branch already contains these commits, which is what
  // "safe to delete" means.
  let ahead = 0;
  if (branch) {
    // Every other local branch, listed explicitly and passed as exclusions.
    //
    // `--exclude=<glob> --branches` reads like the obvious way to say this and
    // silently did not match, so a branch holding a real commit was reported as
    // having nothing and its worktree was deleted. Whether the glob is matched
    // against the full ref name or the short one is exactly the sort of detail
    // not worth betting a user's work on — enumerating the refs removes the
    // question. With no other branches the count is every commit, which is the
    // correct answer: nothing else holds them.
    const refs = (await gitQuiet(path, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])) ?? '';
    const others = refs
      .split('\n')
      .map((r) => r.trim())
      .filter((r) => r && r !== `refs/heads/${branch}`);

    // Every other worktree's HEAD, including the main checkout's.
    //
    // Excluding only *other* branches is right for a session branch that no one
    // else has, and wrong the moment a worktree is checked out on a branch the
    // main repository also holds. Then the branch is left out of its own safety
    // check and every commit unique to it is counted as stranded — two
    // worktrees sitting on master reported forty-nine uncollected commits for
    // days while `git` put them at zero ahead and zero behind, because master
    // was holding those commits in the main checkout the entire time.
    //
    // The question was never "is this branch unique" but "would deleting this
    // directory lose anything", and anything another checkout has its own hold
    // on is not lost by deleting this one.
    const elsewhere = await headsOfOtherWorktrees(path);

    const only = await gitQuiet(path, [
      'rev-list', '--count', 'HEAD', '--not', ...others, ...elsewhere,
    ]);
    ahead = Number(only ?? 0) || 0;
  }

  const commonDir = await gitQuiet(path, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const origin = commonDir?.replace(/[/\\]\.git$/, '') ?? null;

  return {
    path,
    branch,
    dirty: Boolean(status && status.length > 0),
    ahead,
    originMissing: !origin || !existsSync(origin),
  };
}

/**
 * Removes a session's worktree, but only when there is nothing in it.
 *
 * Returns what it decided and why, because "kept" is a result the caller should
 * report rather than treat as failure.
 */
/**
 * When each path was last reported as kept, and in what state.
 *
 * reclaimCleanWorktrees calls releaseWorktree for every finished session that
 * still has a worktree, on every supervisor tick - every fifteen seconds. A
 * worktree that is dirty is kept, correctly, and used to record an event saying
 * so each time.
 *
 * Two worktrees left dirty in August produced 88,333 events between them:
 * 11,514 a day, which is exactly two paths times four ticks a minute. That is
 * 98.7% of every event in the database and 45 MB, and it buries the feed Today
 * reads - a real event became one row in eight hundred.
 *
 * So the event fires when the answer changes, not when it is asked. The state
 * is part of the key because dirty becoming 3-commits-ahead is news; dirty
 * still being dirty a quarter of a minute later is not.
 */
const lastKeptReport = new Map<string, string>();

export async function releaseWorktree(
  sessionId: string,
  path: string,
): Promise<{ removed: boolean; reason: string }> {
  const state = await inspectWorktree(path);
  if (!state) {
    await query(`UPDATE sessions SET worktree_path = NULL WHERE id = $1`, [sessionId]);
    return { removed: true, reason: 'already gone' };
  }

  if (state.dirty || state.ahead > 0) {
    const reason = state.dirty
      ? 'uncommitted changes — kept for review'
      : `${state.ahead} unmerged commit(s) — kept for review`;
    const signature = `${state.dirty}:${state.ahead}:${state.branch ?? ''}`;
    if (lastKeptReport.get(path) !== signature) {
      lastKeptReport.set(path, signature);
      await recordEvent({
        type: 'worktree.kept',
        severity: 'info',
        sessionId,
        message: `${path}: ${reason}`,
        data: { path, branch: state.branch, dirty: state.dirty, ahead: state.ahead },
      });
    }
    return { removed: false, reason };
  }

  // Everything past this point is irreversible, and the path came from a
  // database column.
  //
  // Today the only writer is createWorktree, which builds the path itself under
  // config.paths.worktrees, so nothing can currently reach here with anything
  // else. That is an argument about the current callers rather than about this
  // function, and the failure it protects against is losing a repository:
  // inspectWorktree accepts any directory that is its own git toplevel, which
  // includes a main checkout, so a worktree_path of C:\example-workspace\simba would
  // pass every check above and then be handed to rm -rf.
  //
  // confine() resolves symlinks before comparing, which a prefix test on the
  // raw string does not - a symlink under var/worktrees pointing at the repo
  // would otherwise satisfy it.
  const confined = await confine(path, [config.paths.worktrees]);
  const rootReal = await realpath(config.paths.worktrees).catch(() => null);
  if (!confined || (rootReal && confined === rootReal)) {
    await recordEvent({
      type: 'worktree.refused',
      severity: 'warn',
      sessionId,
      message:
        `Refusing to delete ${path}: it is not inside ${config.paths.worktrees}. ` +
        `The session row was cleared, but nothing on disk was touched.`,
      data: { path, worktreesRoot: config.paths.worktrees },
    });
    await query(`UPDATE sessions SET worktree_path = NULL WHERE id = $1`, [sessionId]);
    return { removed: false, reason: 'outside the worktrees root - refused' };
  }

  const root = (await gitQuiet(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
    ?.replace(/[/\\]\.git$/, '');

  if (root) await gitQuiet(root, ['worktree', 'remove', '--force', path]);
  if (existsSync(path)) await rm(path, { recursive: true, force: true });
  // The branch has nothing on it by definition of reaching here.
  if (root && state.branch) await gitQuiet(root, ['branch', '-D', state.branch]);

  lastKeptReport.delete(path);
  await query(`UPDATE sessions SET worktree_path = NULL WHERE id = $1`, [sessionId]);
  await recordEvent({
    type: 'worktree.removed',
    severity: 'debug',
    sessionId,
    message: `${path}: clean, removed`,
  });
  return { removed: true, reason: 'clean' };
}

/**
 * Worktrees whose sessions are over but which still hold work.
 *
 * Without this they accumulate invisibly: the session list shows "completed"
 * and a directory somewhere holds the only copy of what the agent actually did.
 */
export async function unreapedWorktrees(): Promise<
  Array<{ sessionId: string | null; agent: string; state: WorktreeState }>
> {
  // The directory is the ground truth, not the sessions table.
  //
  // Joining sessions was the first attempt and it hides the worst case: a
  // worktree whose session row is gone — deleted, reset, or never written —
  // becomes permanently invisible while still holding the only copy of an
  // agent's work. That was not hypothetical, it happened here immediately.
  // Enumerating the directory finds those; the session join then supplies a
  // name where one exists.
  let entries: string[] = [];
  try {
    entries = await readdir(config.paths.worktrees);
  } catch {
    return []; // No worktrees directory yet.
  }

  const rows = await query<{ id: string; agent: string; worktree_path: string; status: string }>(
    `SELECT s.id, a.slug AS agent, s.worktree_path, s.status
       FROM sessions s JOIN agents a ON a.id = s.agent_id
      WHERE s.worktree_path IS NOT NULL`,
  );
  const bySessionPath = new Map(rows.map((r) => [r.worktree_path.toLowerCase(), r]));

  const out: Array<{ sessionId: string | null; agent: string; state: WorktreeState }> = [];
  for (const name of entries) {
    const path = join(config.paths.worktrees, name);
    const owner = bySessionPath.get(path.toLowerCase());

    // A live session is still using its checkout; that is not uncollected work.
    if (owner && ['running', 'idle', 'pending'].includes(owner.status)) continue;

    const state = await inspectWorktree(path);
    if (!state) continue;
    if (!state.dirty && state.ahead === 0) continue;

    out.push({
      sessionId: owner?.id ?? null,
      // The directory is named "<agent>-<session prefix>", so the agent is
      // recoverable even when the row is not.
      agent: owner?.agent ?? `${name.split('-')[0] ?? name} (orphaned)`,
      state,
    });
  }
  return out;
}
