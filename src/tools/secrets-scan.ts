import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { homedir } from 'node:os';

import { query, recordEvent, closePool } from '../db/index.js';

/**
 * Credential scanner.
 *
 * Motivated by a real finding: a live Discord bot token sat in plaintext across
 * six OpenClaw config files, alongside a config that granted anyone who could
 * DM that bot unrestricted execution on this machine. Nothing surfaced it —
 * it was found by reading the file for an unrelated reason.
 *
 * Scope is deliberately the user's own machine, not repositories on the
 * internet. It reports; it never edits or rotates. Rotation is a decision with
 * consequences (breaking whatever uses the credential) and belongs to a human.
 */

interface Pattern {
  name: string;
  re: RegExp;
  severity: 'critical' | 'high' | 'medium';
}

const PATTERNS: Pattern[] = [
  // Long-lived and directly abusable.
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/, severity: 'critical' },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, severity: 'critical' },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, severity: 'critical' },
  { name: 'Stripe secret key', re: /\bsk_live_[A-Za-z0-9]{16,}\b/, severity: 'critical' },
  { name: 'OpenAI key', re: /\bsk-[A-Za-z0-9_-]{32,}\b/, severity: 'critical' },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/, severity: 'critical' },
  { name: 'Discord bot token', re: /\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/, severity: 'critical' },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, severity: 'critical' },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: 'high' },

  // JWTs are worth flagging but are often short-lived or public-scoped, so they
  // sit below the keys above rather than alongside them.
  { name: 'JWT (possible service key)', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, severity: 'high' },

  // Assignment-shaped secrets: high recall, so kept at medium to avoid drowning
  // the real findings.
  { name: 'Hardcoded secret assignment', re: /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i, severity: 'medium' },
];

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'venv', '.venv', '__pycache__',
  'target', '.gradle', '.next', 'vendor', 'Cache', 'cache', 'logs',
  // Test fixtures are the dominant source of false positives: they are full of
  // realistic-looking keys that are deliberately fake. A scanner that reports
  // them buries the handful of real findings, which is worse than not scanning.
  'tests', 'test', '__tests__', 'spec', 'fixtures', '__fixtures__', 'examples',
]);

/**
 * Paths belonging to code that is not the user's.
 *
 * The reel bot clones third-party repositories to evaluate them, and their
 * committed test keys are not this machine's exposure. Reporting them as
 * findings makes the report useless.
 */
const FOREIGN_PATH = /[\\/](repos|research|third[_-]?party|external)[\\/]/i;

const SCAN_EXT = new Set([
  '.json', '.env', '.toml', '.yaml', '.yml', '.ini', '.conf', '.cfg',
  '.ts', '.js', '.mjs', '.cjs', '.py', '.ps1', '.sh', '.bat', '.cmd',
  '.txt', '.md', '.xml', '.properties', '.bak',
]);

export interface Finding {
  path: string;
  pattern: string;
  severity: string;
  line: number;
  /** Masked. The value itself is never stored or printed. */
  preview: string;
}

function mask(secret: string): string {
  if (secret.length <= 12) return '*'.repeat(secret.length);
  return `${secret.slice(0, 4)}${'*'.repeat(12)}${secret.slice(-4)}`;
}

async function* walk(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > 6) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full, depth + 1);
    } else if (SCAN_EXT.has(extname(e.name).toLowerCase()) || e.name.startsWith('.env')) {
      yield full;
    }
  }
}

export async function scanPaths(roots: string[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!existsSync(root)) continue;
    for await (const file of walk(root)) {
      if (FOREIGN_PATH.test(file)) continue;
      try {
        // Skip anything large enough to be data rather than config.
        const info = await stat(file);
        if (info.size > 2 * 1024 * 1024) continue;

        const content = await readFile(file, 'utf8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (line.length > 4000) continue;
          for (const p of PATTERNS) {
            const m = p.re.exec(line);
            if (!m) continue;
            // One finding per file+pattern: a token repeated across a config
            // and its five backups is one problem, not six.
            const key = `${file}::${p.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            findings.push({
              path: file,
              pattern: p.name,
              severity: p.severity,
              line: i + 1,
              preview: mask(m[0]),
            });
          }
        }
      } catch {
        // Unreadable or binary; not worth reporting.
      }
    }
  }

  const rank = { critical: 0, high: 1, medium: 2 } as Record<string, number>;
  return findings.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
}

async function main(): Promise<void> {
  const home = homedir();
  const roots = process.argv.slice(2).length
    ? process.argv.slice(2)
    : [
        join(home, '.openclaw'),
        join(home, 'simba', 'config'),
        join(home, 'projects'),
        join(home, 'ReelAgent'),
        join(home, '.codex'),
        join(home, 'Documents', 'Codex'),
      ];

  console.log(`scanning ${roots.length} root(s)…`);
  const findings = await scanPaths(roots);

  if (findings.length === 0) {
    console.log('no exposed credentials found');
  } else {
    console.log(`\n${findings.length} finding(s):\n`);
    for (const f of findings) {
      console.log(`  [${f.severity.toUpperCase()}] ${f.pattern}`);
      console.log(`    ${f.path}:${f.line}  ${f.preview}`);
    }
  }

  // Stored as a document so it is searchable and comparable against the next
  // run, rather than being a console dump nobody sees again.
  const body = findings.length
    ? findings
        .map((f) => `- [${f.severity}] ${f.pattern} — ${f.path}:${f.line} (${f.preview})`)
        .join('\n')
    : 'No exposed credentials found.';

  const doc = await query<{ id: string }>(
    `INSERT INTO documents (slug, kind, scope, title, current_revision)
     VALUES ('secrets-audit', 'analysis', 'global', 'Credential exposure audit', 1)
     ON CONFLICT (scope, slug,
                  coalesce(agent_id,'00000000-0000-0000-0000-000000000000'::uuid),
                  coalesce(project_id,'00000000-0000-0000-0000-000000000000'::uuid),
                  coalesce(session_id,'00000000-0000-0000-0000-000000000000'::uuid))
     DO UPDATE SET current_revision = documents.current_revision + 1, updated_at = now()
     RETURNING id, current_revision`,
  );

  if (doc[0]) {
    const rev = await query<{ current_revision: number }>(
      `SELECT current_revision FROM documents WHERE id = $1`,
      [doc[0].id],
    );
    await query(
      `INSERT INTO document_revisions (document_id, revision, content, summary)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (document_id, revision) DO UPDATE SET content = EXCLUDED.content`,
      [
        doc[0].id,
        rev[0]?.current_revision ?? 1,
        body,
        `${findings.length} finding(s) across ${roots.length} roots`,
      ],
    );
  }

  await recordEvent({
    type: 'security.secrets_audit',
    severity: findings.some((f) => f.severity === 'critical') ? 'warn' : 'info',
    message: `${findings.length} credential finding(s)`,
    data: { critical: findings.filter((f) => f.severity === 'critical').length },
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
