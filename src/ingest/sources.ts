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

/**
 * Reads the knowledge corpus straight from Supabase PostgREST, bypassing the
 * Worker.
 *
 * The Worker in front of this table currently returns empty results for every
 * read while the table itself holds thousands of rows: it checks `res.ok` on
 * its write paths but not on any read path, so an auth failure is swallowed and
 * surfaces as `[]` rather than an error. Going direct removes that failure mode
 * from the ingest path entirely — and it is faster, since it can page properly
 * instead of probing with search terms.
 *
 * Needs a service key (SIMBA_SUPABASE_KEY); the anon key will be filtered by
 * RLS, which is enabled on this table.
 */
export async function* readSupabaseKnowledge(
  supabaseUrl: string,
  serviceKey: string,
): AsyncGenerator<IngestItem> {
  const pageSize = 500;
  let offset = 0;

  for (;;) {
    const url =
      `${supabaseUrl}/rest/v1/knowledge` +
      `?select=id,content,category,subcategory,tags,source,confidence,sensitivity,created_at` +
      `&order=created_at.asc&limit=${pageSize}&offset=${offset}`;

    const res = await fetch(url, {
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(60_000),
    });

    // Unlike the Worker, a failed read is an error here rather than an empty page.
    if (!res.ok) {
      throw new Error(
        `supabase knowledge read failed (${res.status}): ${await res.text().catch(() => '')}`,
      );
    }

    const rows = (await res.json()) as Array<Record<string, unknown>>;
    if (rows.length === 0) return;

    for (const r of rows) {
      const content = String(r.content ?? '');
      if (!content.trim()) continue;

      yield {
        externalId: String(r.id ?? hashContent(content)),
        title: String(r.content ?? '').slice(0, 80),
        content,
        category: String(r.category ?? 'personal'),
        tags: [
          ...(Array.isArray(r.tags) ? (r.tags as string[]) : []),
          ...(r.subcategory ? [String(r.subcategory)] : []),
        ],
        metadata: {
          source: r.source ?? null,
          confidence: r.confidence ?? null,
          sensitivity: r.sensitivity ?? null,
        },
        sourceCreatedAt: r.created_at ? new Date(String(r.created_at)) : null,
      };
    }

    if (rows.length < pageSize) return;
    offset += pageSize;
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

  // Newer exports shard conversations across `conversations-000.json` …
  // `conversations-018.json` instead of shipping one `conversations.json`.
  // Assuming the single-file layout silently yields nothing on a modern export,
  // which looks identical to "you have no history".
  const files: string[] = [];
  if ((await stat(path)).isDirectory()) {
    const entries = await readdir(path);
    for (const e of entries.sort()) {
      if (/^conversations(-\d+)?\.json$/i.test(e)) files.push(join(path, e));
    }
  } else {
    files.push(path);
  }

  for (const file of files) {
    if (!existsSync(file)) continue;
    yield* readChatGptFile(file);
  }
}

async function* readChatGptFile(file: string): AsyncGenerator<IngestItem> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
  const raw = Array.isArray(parsed)
    ? (parsed as Array<Record<string, unknown>>)
    : ((parsed as Record<string, unknown>).conversations as Array<Record<string, unknown>>) ?? [];

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
 * conversation, plus `memories.json` and `projects/` alongside it.
 *
 * `memories.json` is small but disproportionately valuable — it is what Claude
 * already concluded about the operator, so it is exactly the kind of durable fact the
 * hydration bundle should be able to recall. It is picked up automatically when
 * a directory is passed.
 */
export async function* readClaudeExport(path: string): AsyncGenerator<IngestItem> {
  if (!existsSync(path)) return;

  const isDir = (await stat(path)).isDirectory();
  const file = isDir ? join(path, 'conversations.json') : path;

  if (isDir) {
    yield* readClaudeMemories(join(path, 'memories.json'));
    yield* readClaudeProjects(join(path, 'projects'));
  }

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

/** Claude's own accumulated memory about the user. Small, dense, high-signal. */
async function* readClaudeMemories(file: string): AsyncGenerator<IngestItem> {
  if (!existsSync(file)) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return;
  }

  // Shape has changed across export versions, so accept an array, a wrapper
  // object, or a bare map rather than committing to one layout.
  const entries: Array<Record<string, unknown>> = Array.isArray(parsed)
    ? (parsed as Array<Record<string, unknown>>)
    : Array.isArray((parsed as Record<string, unknown>)?.memories)
      ? ((parsed as Record<string, unknown>).memories as Array<Record<string, unknown>>)
      : Object.entries(parsed as Record<string, unknown>).map(([k, v]) => ({
          id: k,
          content: typeof v === 'string' ? v : JSON.stringify(v),
        }));

  let i = 0;
  for (const m of entries) {
    const content = String(m.content ?? m.text ?? m.summary ?? JSON.stringify(m));
    if (!content.trim() || content === '{}') continue;
    i += 1;
    yield {
      externalId: `memory:${String(m.id ?? i)}`,
      title: String(m.title ?? `Claude memory ${i}`),
      content,
      category: 'claude-memory',
      tags: ['claude', 'memory', 'about-operator'],
      metadata: m,
      sourceCreatedAt: m.created_at ? new Date(String(m.created_at)) : null,
    };
  }
}

/** Project instructions and knowledge attached to Claude Projects. */
async function* readClaudeProjects(dir: string): AsyncGenerator<IngestItem> {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const f of files) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await readFile(join(dir, f), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }

    const parts = [
      parsed.prompt_template ? `Instructions:\n${String(parsed.prompt_template)}` : '',
      Array.isArray(parsed.docs)
        ? (parsed.docs as Array<Record<string, unknown>>)
            .map((d) => `## ${String(d.filename ?? 'doc')}\n${String(d.content ?? '')}`)
            .join('\n\n')
        : '',
    ].filter(Boolean);

    const content = parts.join('\n\n');
    if (!content.trim()) continue;

    yield {
      externalId: `project:${String(parsed.uuid ?? f)}`,
      title: String(parsed.name ?? f.replace('.json', '')),
      content,
      category: 'claude-project',
      tags: ['claude', 'project'],
      metadata: { name: parsed.name },
      sourceCreatedAt: parsed.created_at ? new Date(String(parsed.created_at)) : null,
    };
  }
}
