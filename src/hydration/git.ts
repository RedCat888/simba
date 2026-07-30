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
