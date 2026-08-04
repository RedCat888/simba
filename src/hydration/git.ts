import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitState {
  branch: string | null;
  head: string | null;
  dirty: boolean;
  diffstat: string | null;
  recentFiles: string[];
  recentCommits: string[];
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export interface FileDiff {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked';
  additions: number;
  deletions: number;
  patch: string | null;
  /** True when the patch was withheld because it is too large to send. */
  truncated: boolean;
}

export interface SessionDiff {
  branch: string | null;
  head: string | null;
  files: FileDiff[];
  commits: Array<{ sha: string; subject: string; at: string }>;
  totalAdditions: number;
  totalDeletions: number;
}

/** Beyond this a single patch is summarised rather than sent to a phone. */
const MAX_PATCH_CHARS = 24_000;

function parseNumstat(out: string | null): Map<string, { a: number; d: number }> {
  const map = new Map<string, { a: number; d: number }>();
  if (!out) return map;
  for (const line of out.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [add, del, path] = parts;
    if (!path) continue;
    // Binary files report "-" rather than a count.
    map.set(path, { a: Number(add) || 0, d: Number(del) || 0 });
  }
  return map;
}

/**
 * What a session actually changed, as a reviewable diff.
 *
 * Simba recorded a diffstat — the summary line — and nothing else, so from the
 * phone it was possible to see that an agent had touched eleven files and
 * impossible to see what it did to them. For a system whose entire premise is
 * unattended work, that is the wrong thing to be missing: reviewing the change
 * is how the work becomes trustworthy rather than merely finished.
 *
 * Untracked files are included deliberately. An agent that creates a new file
 * has done something at least as consequential as editing one, and `git diff`
 * alone would show nothing at all.
 */
export async function captureSessionDiff(
  cwd: string,
  opts: { since?: string | null } = {},
): Promise<SessionDiff | null> {
  const inRepo = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inRepo !== 'true') return null;

  const [branch, head, numstat, nameStatus, untrackedRaw] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['diff', '--numstat', 'HEAD']),
    git(cwd, ['diff', '--name-status', 'HEAD']),
    git(cwd, ['ls-files', '--others', '--exclude-standard']),
  ]);

  const counts = parseNumstat(numstat);
  const files: FileDiff[] = [];

  for (const line of (nameStatus ?? '').split('\n')) {
    const [code, path] = line.split('\t');
    if (!path || !code) continue;
    const status: FileDiff['status'] =
      code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified';

    const patch = await git(cwd, ['diff', 'HEAD', '--', path]);
    const tooBig = (patch?.length ?? 0) > MAX_PATCH_CHARS;
    const c = counts.get(path) ?? { a: 0, d: 0 };
    files.push({
      path,
      status,
      additions: c.a,
      deletions: c.d,
      patch: tooBig ? null : patch,
      truncated: tooBig,
    });
  }

  for (const path of (untrackedRaw ?? '').split('\n').filter(Boolean)) {
    // /dev/null against the file gives a real patch for something git does not
    // yet track. --no-index exits non-zero by design when there is a
    // difference, which is why git() swallowing errors matters here.
    const patch = await git(cwd, ['diff', '--no-index', '--', '/dev/null', path]);
    const tooBig = (patch?.length ?? 0) > MAX_PATCH_CHARS;
    files.push({
      path,
      status: 'untracked',
      additions: patch ? patch.split('\n').filter((l) => l.startsWith('+')).length : 0,
      deletions: 0,
      patch: tooBig ? null : patch,
      truncated: tooBig,
    });
  }

  const logArgs = ['log', '--format=%H%x09%s%x09%cI', '-20'];
  if (opts.since) logArgs.push(`--since=${opts.since}`);
  const commits = ((await git(cwd, logArgs)) ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, subject, at] = l.split('\t');
      return { sha: (sha ?? '').slice(0, 8), subject: subject ?? '', at: at ?? '' };
    });

  return {
    branch,
    head,
    files,
    commits,
    totalAdditions: files.reduce((n, f) => n + f.additions, 0),
    totalDeletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

/**
 * Working-tree state at checkpoint time.
 *
 * This is the highest-fidelity part of any handoff: a receiving agent inherits
 * the actual edits, so the diff carries far more real context than replaying a
 * transcript would. Cheap to collect and worth collecting every time.
 */
export async function captureGitState(cwd: string): Promise<GitState> {
  const inRepo = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inRepo !== 'true') {
    return { branch: null, head: null, dirty: false, diffstat: null, recentFiles: [], recentCommits: [] };
  }

  const [branch, head, status, diffstat, commits] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['status', '--porcelain']),
    git(cwd, ['diff', '--stat', 'HEAD']),
    git(cwd, ['log', '-8', '--oneline', '--no-decorate']),
  ]);

  const recentFiles = (status ?? '')
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .slice(0, 60);

  return {
    branch,
    head,
    dirty: Boolean(status && status.length > 0),
    diffstat: diffstat || null,
    recentFiles,
    recentCommits: (commits ?? '').split('\n').filter(Boolean),
  };
}
