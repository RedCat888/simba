import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Locating agent CLIs.
 *
 * Not one of them is reliably on PATH here, and each is installed by a
 * different mechanism:
 *   claude       native installer -> ~/.local/bin
 *   cursor-agent own installer    -> %LOCALAPPDATA%\cursor-agent
 *   codex        not on PATH at all; a project-local npm install inside the
 *                Reel-to-Action tree, which deliberately avoids the Windows
 *                Store executable
 *
 * Hardcoding paths works until an update moves one. Candidates are probed in
 * order and the result cached for the process lifetime.
 */

const home = homedir();

interface Candidate {
  path: string;
  /** Prefix args, for shims that are really a package runner. */
  prefixArgs?: string[];
}

const CANDIDATES: Record<string, Candidate[]> = {
  claude: [
    { path: process.env.SIMBA_CLAUDE_BIN ?? '' },
    { path: join(home, '.local', 'bin', 'claude.exe') },
    { path: join(home, '.local', 'bin', 'claude') },
    { path: join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd') },
  ],
  codex: [
    { path: process.env.SIMBA_CODEX_BIN ?? '' },
    {
      // Installed locally by the Reel-to-Action project, which pins its own
      // copy rather than relying on a global install.
      path: join(
        home, 'Documents', 'Codex', '2026-07-22',
        'when-on-instagram-and-watching-reels', 'node_modules', '.bin', 'codex.cmd',
      ),
    },
    { path: join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd') },
    { path: join(home, '.codex', 'bin', 'codex.exe') },
  ],
  'cursor-agent': [
    { path: process.env.SIMBA_CURSOR_BIN ?? '' },
    { path: join(home, 'AppData', 'Local', 'cursor-agent', 'cursor-agent.cmd') },
    { path: join(home, 'AppData', 'Local', 'cursor-agent', 'cursor-agent.exe') },
    { path: join(home, 'AppData', 'Roaming', 'npm', 'cursor-agent.cmd') },
  ],
  opencode: [
    { path: process.env.SIMBA_OPENCODE_BIN ?? '' },
    // The scoop shim is listed ahead of the AppData install deliberately: both
    // exist on this machine at different versions and share one SQLite store,
    // which is what produced the "no such column: name" corruption. Pinning the
    // newer one keeps the schema consistent with whatever last wrote it.
    { path: join(home, 'scoop', 'shims', 'opencode.exe') },
    { path: join(home, 'AppData', 'Local', 'opencode', 'opencode-cli.exe') },
  ],
};

/** Last-resort package-runner invocations when nothing is installed locally. */
const NPX_FALLBACK: Record<string, Candidate> = {
  codex: { path: 'npx.cmd', prefixArgs: ['-y', '@openai/codex@latest'] },
};

export interface ResolvedExecutor {
  path: string;
  prefixArgs: string[];
}

const cache = new Map<string, ResolvedExecutor | null>();

async function onPath(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('where', [name], { timeout: 8000, windowsHide: true });
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    return first ?? null;
  } catch {
    return null;
  }
}

export async function resolveExecutor(cli: string): Promise<ResolvedExecutor | null> {
  if (cache.has(cli)) return cache.get(cli) ?? null;

  for (const candidate of CANDIDATES[cli] ?? []) {
    if (candidate.path && existsSync(candidate.path)) {
      const resolved = { path: candidate.path, prefixArgs: candidate.prefixArgs ?? [] };
      cache.set(cli, resolved);
      return resolved;
    }
  }

  const fromPath = await onPath(cli);
  if (fromPath) {
    const resolved = { path: fromPath, prefixArgs: [] };
    cache.set(cli, resolved);
    return resolved;
  }

  const fallback = NPX_FALLBACK[cli];
  if (fallback) {
    const npx = (await onPath('npx')) ?? fallback.path;
    const resolved = { path: npx, prefixArgs: fallback.prefixArgs ?? [] };
    cache.set(cli, resolved);
    return resolved;
  }

  cache.set(cli, null);
  return null;
}

/**
 * Builds a spawn invocation that survives Windows argument handling.
 *
 * `.cmd` and `.bat` shims cannot be executed directly by CreateProcess, and
 * `shell: true` concatenates argv without quoting — so any argument containing
 * a space is torn apart. Routing through `cmd.exe /d /s /c` with explicit
 * quoting and `windowsVerbatimArguments` is what cross-spawn does and is the
 * only reliable option here.
 */
export function buildSpawn(
  bin: string,
  args: string[],
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  const lower = bin.toLowerCase();
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) {
    return { command: bin, args, windowsVerbatimArguments: false };
  }

  const quote = (s: string) => (/[\s"^&|<>()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const line = [quote(bin), ...args.map(quote)].join(' ');
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/** Which CLIs are actually usable on this machine, for the routing chain. */
export async function availableExecutors(clis: string[]): Promise<string[]> {
  const found = await Promise.all(
    clis.map(async (c) => ((await resolveExecutor(c)) ? c : null)),
  );
  return found.filter((c): c is string => c !== null);
}
