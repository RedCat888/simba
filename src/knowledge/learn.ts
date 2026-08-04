import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

import { query } from '../db/index.js';
import { cheapComplete } from '../hydration/cheap.js';
import { saveSkill } from './skills.js';

/**
 * Turn something that worked into a skill.
 *
 * Skills already existed and agents already write them, but only when an agent
 * happens to notice mid-task that what it just did is reusable. That covers the
 * lucky case. This covers the deliberate one: point at a session that solved
 * something, a pasted procedure, a documentation page, or a directory of code,
 * and get a skill out of it.
 *
 * Taken from Hermes' /learn, which is the feature that makes its skill store
 * fill up with things worth having rather than staying at whatever was shipped.
 *
 * Distillation runs on the cheap chain — free tier first. Learning that costs
 * subscription headroom every time is learning that gets switched off, and this
 * is exactly the kind of bounded, low-stakes summarisation the free brain
 * handles well.
 */

export type LearnSource =
  | { from: 'session'; sessionId: string }
  | { from: 'text'; text: string }
  | { from: 'url'; url: string }
  | { from: 'path'; path: string };

const PROMPT = `You are writing a reusable skill for an autonomous agent that will
read it months from now with no memory of this conversation.

Return ONLY a JSON object:
{
  "name": "lowercase-kebab-case, max 64 chars, names the situation not the tool",
  "description": "Starts with the trigger: \\"Use when …\\". Only the first 57 characters are ever shown in the agent's index, so the trigger must come first and be specific.",
  "body": "Markdown. The actual procedure.",
  "tags": ["three", "or", "four"]
}

The body must be a procedure, not an essay:
- Real commands, real paths, real flags — copied exactly, not paraphrased.
- The gotcha that cost time, stated plainly, with the wrong result it produces.
- How to verify it worked, by checking the outcome rather than trusting output.
- What NOT to do, when a wrong approach looks correct.

Omit anything you cannot support from the source. A short accurate skill beats a
long one containing invented steps. If the source contains nothing reusable,
return {"name":"","description":"","body":"","tags":[]} rather than inventing a skill.

Source follows.
---
`;

/** Text files worth reading when pointed at a directory. */
const READABLE = new Set([
  '.md', '.txt', '.ts', '.js', '.py', '.sql', '.sh', '.ps1', '.json', '.yaml', '.yml', '.kt', '.toml',
]);

async function gather(source: LearnSource): Promise<{ text: string; label: string }> {
  switch (source.from) {
    case 'text':
      return { text: source.text, label: 'pasted text' };

    case 'url': {
      // Deliberately plain: this reads public documentation, and anything
      // needing credentials should be fetched by the agent and passed as text.
      const res = await fetch(source.url, {
        signal: AbortSignal.timeout(30_000),
        headers: { 'user-agent': 'simba-learn/1.0' },
      });
      if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
      const html = await res.text();
      const stripped = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return { text: stripped, label: source.url };
    }

    case 'path': {
      const info = await stat(source.path);
      if (info.isFile()) {
        return { text: await readFile(source.path, 'utf8'), label: source.path };
      }
      const entries = await readdir(source.path, { withFileTypes: true });
      const parts: string[] = [];
      for (const e of entries.slice(0, 40)) {
        if (!e.isFile() || !READABLE.has(extname(e.name))) continue;
        const body = await readFile(join(source.path, e.name), 'utf8').catch(() => '');
        // Heads only. A skill is distilled from shape and conventions, and
        // whole files would blow the context for no extra signal.
        parts.push(`--- ${e.name} ---\n${body.slice(0, 4000)}`);
      }
      return { text: parts.join('\n\n'), label: source.path };
    }

    case 'session': {
      const messages = await query<{ role: string; content: string | null }>(
        `SELECT role, content FROM messages
          WHERE session_id = $1 AND content IS NOT NULL AND content <> ''
          ORDER BY seq`,
        [source.sessionId],
      );
      const tools = await query<{ name: string; args: unknown; is_error: boolean; result_text: string | null }>(
        `SELECT name, args, is_error, result_text FROM tool_calls
          WHERE session_id = $1 ORDER BY created_at`,
        [source.sessionId],
      );

      const lines = messages.map((m) => `[${m.role}] ${(m.content ?? '').slice(0, 2000)}`);
      lines.push('\n--- what was actually run ---');
      for (const t of tools) {
        // Failures matter more than successes here: the thing worth writing
        // down is usually what went wrong before it went right.
        const outcome = t.is_error ? `FAILED: ${(t.result_text ?? '').slice(0, 300)}` : 'ok';
        lines.push(`${t.name}(${JSON.stringify(t.args ?? {}).slice(0, 300)}) -> ${outcome}`);
      }
      return { text: lines.join('\n'), label: `session ${source.sessionId.slice(0, 8)}` };
    }
  }
}

export interface LearnResult {
  learned: boolean;
  name?: string;
  version?: number;
  created?: boolean;
  reason?: string;
}

export async function learn(
  source: LearnSource,
  opts: { sessionId?: string | null; configDir?: string | null } = {},
): Promise<LearnResult> {
  const { text, label } = await gather(source);
  const trimmed = text.trim();
  if (trimmed.length < 200) {
    return { learned: false, reason: `${label} has too little in it to distil a skill from` };
  }

  const raw = await cheapComplete(PROMPT + trimmed, {
    configDir: opts.configDir,
    // Permanent output, bounded volume: worth the better instruction-following.
    // The cheap chain still tries the free tier first.
    maxChars: 60_000,
  });
  if (!raw) return { learned: false, reason: 'the model returned nothing' };

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return { learned: false, reason: 'could not parse a skill out of the response' };
  }

  let parsed: { name?: string; description?: string; body?: string; tags?: string[] };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { learned: false, reason: 'the response was not valid JSON' };
  }

  // An empty name is the model's way of saying there was nothing reusable here,
  // which is a legitimate answer and better than a fabricated skill.
  if (!parsed.name || !parsed.description || !parsed.body) {
    return { learned: false, reason: `nothing reusable found in ${label}` };
  }

  const result = await saveSkill({
    name: parsed.name,
    description: parsed.description,
    body: parsed.body,
    tags: parsed.tags ?? [],
    sessionId: opts.sessionId ?? null,
    source: 'learned',
    note: `learned from ${label}`,
  });

  return { learned: true, name: result.name, version: result.version, created: result.created };
}
