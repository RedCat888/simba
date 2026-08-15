import { readdir, readFile, stat } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { query } from '../db/index.js';
import { config } from '../config.js';
import { PATTERNS } from '../tools/secret-patterns.js';

/**
 * Reading the PC's files from the phone.
 *
 * mobile-cursor-bridge — the operator's attempt at this before Simba — had a file
 * explorer, and it is the last thing from that repo Simba had no answer to.
 * Sessions report which files they touched and the diff shows what changed in
 * them, but there was no way to simply look at one, so "what does that file
 * actually say now" meant walking to the desk.
 *
 * This is the most dangerous surface added to Simba, and the danger is not
 * subtle: it serves file contents over a Cloudflare tunnel to a phone. Three
 * things constrain it, and each exists because the obvious cheaper version is
 * wrong.
 *
 * **Confinement is by resolved path, against roots from the database.** Not by
 * string prefix on the requested path, which `..` defeats, and not by a
 * hardcoded list, which drifts from what actually exists. Symlinks are resolved
 * first, because a link inside a project pointing at C:\ is otherwise a legal
 * way out of the confinement.
 *
 * **Secrets are masked by pattern, not refused by filename.** A deny list of
 * `.env` and `*.pem` is the intuitive design and it fails in the direction that
 * matters: this repository's own scanner exists because a live Discord bot
 * token was found sitting in six ordinary-looking config files. Filenames do
 * not predict secrets. Content does, so the same patterns the scanner hunts
 * with are what this masks with — one list, so the two cannot drift apart.
 *
 * **Reading is all it does.** No write, no delete, no rename. Everything here
 * is recoverable by definition.
 */

/** Big enough for any source file, small enough not to hand a phone a database. */
const MAX_BYTES = 512 * 1024;

/** Directories never worth browsing, and expensive to list. */
const HIDDEN = new Set(['node_modules', '.git', 'venv', '.venv', '__pycache__', 'dist', 'build', 'target', '.gradle', '.next']);

export interface DirEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  bytes: number;
  modified: string | null;
}

export interface FileView {
  path: string;
  bytes: number;
  text: string;
  truncated: boolean;
  /** How many secrets were masked. Surfaced so the masking is visible, not silent. */
  masked: number;
  binary: boolean;
}

/**
 * The directories this is allowed to serve from.
 *
 * Taken from the projects table so it tracks what actually exists rather than a
 * list someone has to remember to update, plus Simba's own root, which is not a
 * scanned project but is the thing most often worth reading from the phone.
 */
export async function allowedRoots(): Promise<string[]> {
  const rows = await query<{ root_path: string }>(
    `SELECT root_path FROM projects WHERE root_path IS NOT NULL AND NOT archived`,
  );
  return [config.root, ...rows.map((r) => r.root_path)].map((p) => resolve(p));
}

/**
 * Resolve a requested path and prove it is inside a root.
 *
 * Returns null rather than throwing, because every rejection here is a normal
 * thing for a client to ask for and none of them deserve a stack trace.
 */
export async function confine(requested: string, roots: string[]): Promise<string | null> {
  let target: string;
  try {
    // realpath first: `..` is handled by resolve, but a symlink pointing out of
    // a project is not, and that is the interesting way through a prefix check.
    target = await realpath(resolve(requested));
  } catch {
    return null; // does not exist, or is not reachable
  }

  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue;
    }
    // The separator matters: without it, /home/user-secrets passes a prefix
    // test against the root /home/user.
    if (target === realRoot || target.startsWith(realRoot + sep)) return target;
  }
  return null;
}

export async function listDir(dir: string): Promise<DirEntry[]> {
  const names = await readdir(dir);
  const out: DirEntry[] = [];
  for (const name of names) {
    if (HIDDEN.has(name)) continue;
    const path = join(dir, name);
    try {
      const s = await stat(path);
      out.push({
        name,
        path,
        kind: s.isDirectory() ? 'dir' : 'file',
        bytes: s.isDirectory() ? 0 : s.size,
        modified: s.mtime.toISOString(),
      });
    } catch {
      // Vanished between readdir and stat, or unreadable. Skipping one entry is
      // better than failing the whole listing.
    }
  }
  // Directories first, then by name — the ordering every file browser uses,
  // because it is the one that matches how people scan a list.
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  return out;
}

/** Replace anything that matches a credential pattern with its shape. */
export function maskSecrets(text: string): { text: string; masked: number } {
  let masked = 0;
  let out = text;
  for (const p of PATTERNS) {
    // Global copy: the source patterns are not /g, and a file can hold several.
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
    out = out.replace(re, (match, ...groups) => {
      masked++;
      // The name and the length, never a prefix of the value. A masked key that
      // shows its first eight characters is a key that has been narrowed for
      // whoever is reading over your shoulder.
      if (p.maskGroup) {
        // Keep everything but the value, so the file still reads as a file.
        const value = groups[p.maskGroup - 1] as string;
        const prefix = groups[0] as string;
        return `${prefix}«redacted, ${value.length} chars»`;
      }
      return `«${p.name} redacted, ${match.length} chars»`;
    });
  }
  return { text: out, masked };
}

export async function readTextFile(path: string): Promise<FileView> {
  const s = await stat(path);
  const buf = await readFile(path);
  const slice = buf.subarray(0, MAX_BYTES);

  // A NUL byte in the first few KB is the standard, boring test, and right far
  // more often than sniffing extensions — this machine holds .mp4, .jpg and
  // .jsonl side by side in the same folders.
  const binary = slice.subarray(0, 8192).includes(0);
  if (binary) {
    return { path, bytes: s.size, text: '', truncated: false, masked: 0, binary: true };
  }

  const { text, masked } = maskSecrets(slice.toString('utf8'));
  return { path, bytes: s.size, text, truncated: s.size > MAX_BYTES, masked, binary: false };
}
