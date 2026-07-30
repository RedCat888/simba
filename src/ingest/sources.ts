import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Source readers. Each yields normalized items; storage, chunking and embedding
 * are handled uniformly downstream so adding a source means adding a reader,
 * not a pipeline.
 */

export interface IngestItem {
  externalId: string;
  title: string;
  content: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  sourceCreatedAt?: Date | null;
}

export function hashContent(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// Obsidian vault
// ---------------------------------------------------------------------------

export async function* readObsidian(vaultPath: string): AsyncGenerator<IngestItem> {
  if (!existsSync(vaultPath)) return;

  async function* walk(dir: string): AsyncGenerator<string> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      // Obsidian's own state directories carry no user content.
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (extname(entry.name).toLowerCase() === '.md') yield full;
    }
  }

  for await (const file of walk(vaultPath)) {
    const content = await readFile(file, 'utf8');
    if (!content.trim()) continue;
    const info = await stat(file);
    const rel = relative(vaultPath, file);

    // Folder names in a vault are meaningful categorization, so keep them.
    const folder = rel.includes('\\') || rel.includes('/')
      ? rel.split(/[\\/]/).slice(0, -1).join('/')
      : null;

    yield {
      externalId: rel,
      title: basename(file, '.md'),
      content,
      category: folder ?? 'vault',
      tags: extractTags(content),
      metadata: { path: rel },
      sourceCreatedAt: info.birthtime ?? info.mtime,
    };
  }
}

/** Obsidian inline `#tag` markers, excluding markdown headings. */
function extractTags(content: string): string[] {
  const tags = new Set<string>();
  for (const m of content.matchAll(/(?:^|\s)#([a-zA-Z][\w/-]{1,40})/g)) {
    if (m[1]) tags.add(m[1].toLowerCase());
  }
  return [...tags].slice(0, 20);
}

// ---------------------------------------------------------------------------
// Existing knowledge vector DB (the Cloudflare Worker API)
// ---------------------------------------------------------------------------

export async function* readKnowledgeApi(
  baseUrl: string,
  token: string,
): AsyncGenerator<IngestItem> {
  // The API exposes search rather than a dump, so a broad sweep of category
  // terms is used to pull the corpus across. Duplicates are removed by
  // content hash downstream, so overlapping queries are harmless.
  const probes = [
    'personal', 'academic', 'career', 'work', 'projects', 'skills', 'essays',
    'college', 'programming', 'goals', 'health', 'family', 'writing', 'server',
  ];

  const seen = new Set<string>();

  for (const q of probes) {
    let results: Array<Record<string, unknown>> = [];
    try {
      const res = await fetch(`${baseUrl}/search`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, limit: 100 }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
      results = body.results ?? [];
    } catch {
      continue;
    }

    for (const r of results) {
      const content = String(r.content ?? '');
      if (!content.trim()) continue;
      const id = String(r.id ?? hashContent(content));
      if (seen.has(id)) continue;
      seen.add(id);

      yield {
        externalId: id,
        title: String(r.title ?? content.slice(0, 60)),
        content,
        category: String(r.category ?? 'personal'),
        tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
        metadata: r,
        sourceCreatedAt: r.created_at ? new Date(String(r.created_at)) : null,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Chat exports
// ---------------------------------------------------------------------------

/**
 * ChatGPT export: `conversations.json`, an array of conversations whose
 * messages hang off a `mapping` of node id -> node. Each conversation is
 * flattened into a single item, because retrieval over a whole conversation
 * beats retrieval over isolated turns for recall about past decisions.
 */
export async function* readChatGptExport(path: string): AsyncGenerator<IngestItem> {
  if (!existsSync(path)) return;
  const file = (await stat(path)).isDirectory() ? join(path, 'conversations.json') : path;
  if (!existsSync(file)) return;

  const raw = JSON.parse(await readFile(file, 'utf8')) as Array<Record<string, unknown>>;

  for (const convo of raw) {
    const mapping = (convo.mapping ?? {}) as Record<string, { message?: Record<string, unknown> }>;
    const lines: string[] = [];

    for (const node of Object.values(mapping)) {
      const msg = node?.message;
      if (!msg) continue;
      const role = ((msg.author as Record<string, unknown>)?.role as string) ?? 'unknown';
      if (role === 'system') continue;
      const parts = ((msg.content as Record<string, unknown>)?.parts ?? []) as unknown[];
      const text = parts.filter((p) => typeof p === 'string').join('\n').trim();
      if (text) lines.push(`[${role}] ${text}`);
    }

    if (lines.length === 0) continue;
    const content = lines.join('\n\n');

    yield {
      externalId: String(convo.id ?? convo.conversation_id ?? hashContent(content)),
      title: String(convo.title ?? 'Untitled conversation'),
      content,
      category: 'chatgpt',
      tags: ['chatgpt', 'conversation'],
      metadata: { turns: lines.length },
      sourceCreatedAt: convo.create_time ? new Date(Number(convo.create_time) * 1000) : null,
    };
  }
}

/**
 * Claude export: `conversations.json` with a `chat_messages` array per
 * conversation. Shape differs from ChatGPT's enough to warrant its own reader.
 */
export async function* readClaudeExport(path: string): AsyncGenerator<IngestItem> {
  if (!existsSync(path)) return;
  const file = (await stat(path)).isDirectory() ? join(path, 'conversations.json') : path;
  if (!existsSync(file)) return;

  const raw = JSON.parse(await readFile(file, 'utf8')) as Array<Record<string, unknown>>;

  for (const convo of raw) {
    const messages = (convo.chat_messages ?? []) as Array<Record<string, unknown>>;
    const lines: string[] = [];

    for (const m of messages) {
      const role = String(m.sender ?? m.role ?? 'unknown');
      let text = String(m.text ?? '').trim();

      // Newer exports put the body in a content-block array instead of `text`.
      if (!text && Array.isArray(m.content)) {
        text = (m.content as Array<Record<string, unknown>>)
          .map((b) => (typeof b.text === 'string' ? b.text : ''))
          .join('\n')
          .trim();
      }
      if (text) lines.push(`[${role}] ${text}`);
    }

    if (lines.length === 0) continue;
    const content = lines.join('\n\n');

    yield {
      externalId: String(convo.uuid ?? convo.id ?? hashContent(content)),
      title: String(convo.name ?? 'Untitled conversation'),
      content,
      category: 'claude',
      tags: ['claude', 'conversation'],
      metadata: { turns: lines.length },
      sourceCreatedAt: convo.created_at ? new Date(String(convo.created_at)) : null,
    };
  }
}
