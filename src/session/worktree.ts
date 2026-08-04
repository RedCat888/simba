import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../config.js';
import { query, recordEvent } from '../db/index.js';

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
}

/** Whether a worktree still holds work nobody has collected. */
export async function inspectWorktree(path: string): Promise<WorktreeState | null> {
  if (!existsSync(path)) return null;
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

    const only = await gitQuiet(path, ['rev-list', '--count', 'HEAD', '--not', ...others]);
    ahead = Number(only ?? 0) || 0;
  }

  return {
    path,
    branch,
    dirty: Boolean(status && status.length > 0),
    ahead,
  };
}

/**
 * Removes a session's worktree, but only when there is nothing in it.
 *
 * Returns what it decided and why, because "kept" is a result the caller should
 * report rather than treat as failure.
 */
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
    await recordEvent({
      type: 'worktree.kept',
      severity: 'info',
      sessionId,
      message: `${path}: ${reason}`,
      data: { path, branch: state.branch, dirty: state.dirty, ahead: state.ahead },
    });
    return { removed: false, reason };
  }

  const root = (await gitQuiet(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
    ?.replace(/[/\\]\.git$/, '');

  if (root) await gitQuiet(root, ['worktree', 'remove', '--force', path]);
  if (existsSync(path)) await rm(path, { recursive: true, force: true });
  // The branch has nothing on it by definition of reaching here.
  if (root && state.branch) await gitQuiet(root, ['branch', '-D', state.branch]);

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
  Array<{ sessionId: string; agent: string; state: WorktreeState }>
> {
  const rows = await query<{ id: string; agent: string; worktree_path: string }>(
    `SELECT s.id, a.slug AS agent, s.worktree_path
       FROM sessions s JOIN agents a ON a.id = s.agent_id
      WHERE s.worktree_path IS NOT NULL
        AND s.status NOT IN ('running', 'idle', 'pending')`,
  );

  const out: Array<{ sessionId: string; agent: string; state: WorktreeState }> = [];
  for (const r of rows) {
    const state = await inspectWorktree(r.worktree_path);
    if (state && (state.dirty || state.ahead > 0)) {
      out.push({ sessionId: r.id, agent: r.agent, state });
    }
  }
  return out;
}
