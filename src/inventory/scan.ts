import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { query, one } from '../db/index.js';

const run = promisify(execFile);

/**
 * Finding the work that exists in exactly one place.
 *
 * Simba knows its own sessions and missions in detail and knew nothing about the
 * forty-odd repositories on the machine it runs on — which made it an operations
 * system that could not answer "what have I got, and what am I about to lose".
 *
 * The scan deliberately asks two questions and no others. Uncommitted files, and
 * commits that are on this disk and nowhere else. Everything else a project
 * inventory might record — what it does, whether it still matters, what stack it
 * is — goes stale the week it is written and nobody updates it. These two do not
 * go stale, are cheap to recompute, and are the only fields that turn a list
 * into something worth opening.
 */

const HOME = homedir();

/**
 * Where to look.
 *
 * His repositories live directly under the home directory and under Documents;
 * scanning the whole drive would spend minutes walking node_modules to find
 * nothing. Depth is capped rather than unbounded for the same reason.
 */
const ROOTS = [HOME, join(HOME, 'Documents'), join(HOME, 'Documents', 'Codex')];
const MAX_DEPTH = 3;

/**
 * Directories that are never a project and are expensive to descend.
 *
 * The second group is the one that is easy to miss: Windows keeps legacy
 * junctions in the profile root — "Local Settings", "Application Data", "My
 * Documents" — which point back into AppData and into the profile itself.
 * Skipping AppData by name is not enough, because the walk re-enters it through
 * those and comes back with temp checkouts reported as the user's projects.
 */
const SKIP = new Set([
  'node_modules', '.git', 'venv', '.venv', '__pycache__', 'dist', 'build',
  'target', '.next', '.cache', 'AppData', 'OneDrive', 'Downloads',
  '.gradle', '.android', '.vscode', '.cursor', 'go', 'scoop',
  'Local Settings', 'Application Data', 'My Documents', 'Start Menu',
  'Templates', 'NetHood', 'PrintHood', 'Recent', 'SendTo', 'Cookies',
]);

export interface ProjectScan {
  name: string;
  path: string;
  remote: string | null;
  branch: string | null;
  dirtyFiles: number;
  unpushed: number;
  lastCommitAt: string | null;
  scanError: string | null;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, { cwd, windowsHide: true, timeout: 15_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Every git repository under the configured roots. */
export async function findRepos(): Promise<string[]> {
  const found = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // Permission denied, or it vanished mid-walk. Neither is fatal.
    }

    // A repository is a leaf for this purpose: descending into one finds its
    // own submodules and vendored copies, which are not separate projects.
    if (entries.includes('.git')) {
      found.add(dir);
      return;
    }

    for (const entry of entries) {
      if (SKIP.has(entry) || entry.startsWith('.')) continue;
      const child = join(dir, entry);
      try {
        if ((await stat(child)).isDirectory()) await walk(child, depth + 1);
      } catch {
        // Symlink loops and junctions; skipping is correct.
      }
    }
  }

  for (const root of ROOTS) {
    if (existsSync(root)) await walk(root, 0);
  }
  return [...found];
}

/** What a single repository is holding. */
export async function inspectRepo(path: string): Promise<ProjectScan> {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const base: ProjectScan = {
    name, path, remote: null, branch: null,
    dirtyFiles: 0, unpushed: 0, lastCommitAt: null, scanError: null,
  };

  const branch = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) {
    // Recorded rather than swallowed. "Nothing at risk" and "could not tell"
    // must never look alike, because the value of a zero here is entirely in
    // being able to trust it.
    return { ...base, scanError: 'not readable as a git repository' };
  }
  base.branch = branch;

  base.remote = (await git(path, ['remote', 'get-url', 'origin'])) || null;

  const status = await git(path, ['status', '--porcelain']);
  base.dirtyFiles = status ? status.split('\n').filter((l) => l.trim()).length : 0;

  // Commits that exist here and nowhere else.
  //
  // `@{upstream}..HEAD` is the obvious form and fails outright on a branch with
  // no upstream, which is exactly the case that matters most — a repository with
  // no remote at all holds *everything* in one place. So when there are no
  // remote-tracking refs the answer is every commit, and when there are, it is
  // whatever they do not already contain.
  const remoteRefs = await git(path, ['for-each-ref', '--format=%(refname)', 'refs/remotes/']);
  const refs = (remoteRefs ?? '').split('\n').map((r) => r.trim()).filter(Boolean);
  const unpushed = await git(path, ['rev-list', '--count', 'HEAD', '--not', ...refs]);
  base.unpushed = Number(unpushed ?? 0) || 0;

  const last = await git(path, ['log', '-1', '--format=%cI']);
  base.lastCommitAt = last || null;

  return base;
}

/** A stable identifier from a directory name, unique-ified on collision. */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

/**
 * Rescan and write the state back onto the projects Simba already knows.
 *
 * Enriches rather than replaces. `projects` has been the durable scope an agent
 * owns since the beginning — sessions and agents carry a project_id — so the
 * scanner's job is to fill in the state columns and leave everything else
 * alone. It owns the measurements and nothing else: not the slug, not the name
 * a human gave it, not whether it is archived.
 *
 * Rows that were never discovered by a scan are left completely untouched. A
 * domain or an account has no working tree, and reporting one as holding zero
 * uncommitted files would be answering a question that was not asked.
 */
export async function scanProjects(): Promise<{ scanned: number; atRisk: number; added: number }> {
  const repos = await findRepos();
  const results = await Promise.all(repos.map((r) => inspectRepo(r)));

  let added = 0;
  for (const p of results) {
    // Slug collisions are real — two checkouts of the same project under
    // different roots — so the path decides identity and the slug just has to
    // be unique. Suffixed rather than rejected, because refusing to record a
    // repository because its name is taken is the wrong failure.
    const base = slugify(p.name);
    const taken = await one<{ slug: string }>(
      `SELECT slug FROM projects WHERE slug = $1 AND root_path IS DISTINCT FROM $2`,
      [base, p.path],
    );
    const slug = taken ? `${base}-${p.path.replace(/[\\/]/g, '-').slice(-8).replace(/^-+/, '')}` : base;

    const row = await one<{ inserted: boolean }>(
      `INSERT INTO projects (slug, name, kind, root_path, git_remote, branch,
                             dirty_files, unpushed, last_commit_at, last_scanned_at, scan_error)
       VALUES ($1,$2,'repo',$3,$4,$5,$6,$7,$8,now(),$9)
       ON CONFLICT (root_path) WHERE root_path IS NOT NULL DO UPDATE SET
         git_remote      = EXCLUDED.git_remote,
         branch          = EXCLUDED.branch,
         dirty_files     = EXCLUDED.dirty_files,
         unpushed        = EXCLUDED.unpushed,
         last_commit_at  = EXCLUDED.last_commit_at,
         last_scanned_at = now(),
         scan_error      = EXCLUDED.scan_error
       RETURNING (xmax = 0) AS inserted`,
      [slug, p.name, p.path, p.remote, p.branch, p.dirtyFiles, p.unpushed, p.lastCommitAt, p.scanError],
    );
    if (row?.inserted) added++;
  }

  // Deliberately no deletion pass. A project that has been moved or is on an
  // unplugged drive would be erased by one, taking its agent ownership and any
  // human note with it — and "the directory is not there right now" is much
  // weaker evidence than that costs. Staleness is visible instead: last_scanned_at
  // stops moving, which says "not seen recently" rather than asserting it is gone.
  return {
    scanned: results.length,
    added,
    atRisk: results.filter((r) => r.dirtyFiles > 0 || r.unpushed > 0).length,
  };
}
