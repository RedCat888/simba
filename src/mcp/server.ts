import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import { query, one, transaction, recordEvent } from '../db/index.js';
import { recall } from '../knowledge/embed.js';
import { viewSkill, listSkills, saveSkill } from '../knowledge/skills.js';
import { addMemory, removeMemory, memoryPressure } from '../knowledge/memory.js';
import { learn } from '../knowledge/learn.js';
import { checkAction, logDenial, type Surface } from '../policy/surface.js';

/**
 * The Simba MCP server: an agent's hands on its own memory.
 *
 * Exposed to every session. Agents read and write documents, search their own
 * history and the personal knowledge corpus, and message other agents — all as
 * database rows. Nothing here writes to disk.
 */

const AGENT_ID = process.env.SIMBA_AGENT_ID ?? null;
const SESSION_ID = process.env.SIMBA_SESSION_ID ?? null;

const server = new Server(
  { name: 'simba', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

function text(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }] };
}

function json(body: unknown): CallToolResult {
  return text(JSON.stringify(body, null, 2));
}

const TOOLS = [
  {
    name: 'doc_read',
    description:
      'Read a shared document from the Simba database by slug. Documents replace SPEC.md, ' +
      'AGENTS.md, HANDOFF.md and every other markdown file — this is where durable notes live.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Document slug' },
        scope: {
          type: 'string',
          enum: ['global', 'agent', 'project', 'session'],
          description: 'Defaults to agent scope.',
        },
      },
      required: ['slug'],
    },
  },
  {
    name: 'doc_write',
    description:
      'Create or update a shared document. Every write creates a new revision attributed to ' +
      'you, so history is preserved. Use this instead of writing a markdown file.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        content: { type: 'string' },
        title: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['note', 'spec', 'brief', 'plan', 'decision', 'inventory', 'analysis', 'runbook'],
        },
        scope: { type: 'string', enum: ['global', 'agent', 'project', 'session'] },
        summary: { type: 'string', description: 'What changed in this revision.' },
      },
      required: ['slug', 'content'],
    },
  },
  {
    name: 'doc_list',
    description: 'List documents visible to you, optionally filtered by kind.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'roster_list',
    description:
      'List all agents: who exists, what domain each owns, what they are working on right now. ' +
      'Use this before assuming you have to do something yourself.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'session_search',
    description:
      'Full-text search across all stored transcripts, including other agents\' sessions. ' +
      'Answers questions like "has anyone dealt with this error before".',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        agent: { type: 'string', description: 'Optional agent slug to restrict to.' },
        limit: { type: 'number' },
      },
      required: ['q'],
    },
  },
  {
    name: 'knowledge_search',
    description:
      'Semantic search over the operator\'s personal knowledge: chat exports, the Obsidian vault, ' +
      'the knowledge database, and prior session summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['q'],
    },
  },
  {
    name: 'memory_add',
    description:
      'Remember a durable fact so it is present on every future turn without being searched for. ' +
      'Use for things about this machine, the accounts, or how the operator wants things done — ' +
      'anything you would otherwise rediscover. Memory is deliberately capped: when it is full ' +
      'you must remove something first. A single fact belongs here; anything with steps belongs ' +
      'in a skill via skill_save.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['environment', 'preference', 'convention', 'person'] },
        content: { type: 'string', description: 'One fact, under 400 characters.' },
        source: { type: 'string', description: 'How you know it.' },
        mine_only: {
          type: 'boolean',
          description: 'Scope to this agent instead of sharing it with all agents.',
        },
      },
      required: ['kind', 'content'],
    },
  },
  {
    name: 'memory_remove',
    description:
      'Forget a memory that is wrong or no longer true. Matches on the text you saw in your ' +
      'brief. Removing is how you make room when memory is full.',
    inputSchema: {
      type: 'object',
      properties: { match: { type: 'string' } },
      required: ['match'],
    },
  },
  {
    name: 'learn',
    description:
      'Distil something into a reusable skill: the work in this session, a pasted procedure, a ' +
      'documentation URL, or a local file or directory. Use after solving something awkward, ' +
      'or when handed instructions worth keeping. Defaults to this session. Runs on the free ' +
      'model tier, so it costs nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          enum: ['session', 'text', 'url', 'path'],
          description: 'Defaults to session.',
        },
        text: { type: 'string', description: 'Required when from is "text".' },
        url: { type: 'string', description: 'Required when from is "url".' },
        path: { type: 'string', description: 'Required when from is "path".' },
        session_id: { type: 'string', description: 'Another session; defaults to this one.' },
      },
    },
  },
  {
    name: 'skill_view',
    description:
      'Load the full text of a skill by name. The Skills section of your brief lists only ' +
      'one-line summaries; read the real procedure with this before relying on it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'skill_list',
    description:
      'List every skill with its full description. Use when the one-line index in your ' +
      'brief was not enough to tell whether a skill applies.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skill_save',
    description:
      'Save a reusable procedure as a skill, or correct one that is wrong. Use this whenever ' +
      'you work something out that you would otherwise have to rediscover, and whenever you ' +
      'find an existing skill inaccurate — passing an existing name revises it and keeps the ' +
      'old version. Lead the description with the trigger ("Use when …"): only its first 57 ' +
      'characters appear in the always-loaded index. The body should be a concrete procedure ' +
      'with real commands, not advice.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'lowercase-kebab-case, max 64 chars.' },
        description: { type: 'string', description: 'Trigger first. "Use when …".' },
        body: { type: 'string', description: 'Markdown. The actual procedure.' },
        tags: { type: 'array', items: { type: 'string' } },
        note: { type: 'string', description: 'Why you are writing or changing this.' },
      },
      required: ['name', 'description', 'body'],
    },
  },
  {
    name: 'note_append',
    description:
      'Append a short note to your running log for this session. Cheaper than a document; ' +
      'use for observations you want to survive into your next session.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string' } },
      required: ['note'],
    },
  },
  {
    name: 'agent_message',
    description:
      'Send a message to another agent. It queues in their inbox and is delivered when they ' +
      'next run, or wakes them if urgent. Use roster_list first to find the right agent.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target agent slug.' },
        intent: { type: 'string', description: 'Short machine-readable intent, e.g. "question".' },
        payload: { type: 'object' },
        wake: { type: 'boolean', description: 'Wake the agent rather than waiting.' },
        reply_to: {
          type: 'string',
          description:
            'When answering a message from inbox_read, pass its id here. This keeps the ' +
            'exchange threaded so the router can tell a conversation from a loop.',
        },
      },
      required: ['to', 'intent'],
    },
  },
  {
    name: 'inbox_read',
    description: 'Read your pending inbox messages from other agents.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mission_plan',
    description:
      'Record the step-by-step plan for a mission. Call this exactly once during planning, ' +
      'then stop — do not begin the work. Each instruction must be self-contained: a ' +
      'different model on a different day will execute it knowing only the mission ' +
      'objective and that instruction.',
    inputSchema: {
      type: 'object',
      properties: {
        mission_id: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              instruction: { type: 'string' },
              kind: {
                type: 'string',
                enum: ['research', 'provision', 'work', 'verify', 'report'],
                description: 'provision = install/configure a tool; verify = run it and check real output',
              },
              depends_on: {
                type: 'array',
                items: { type: 'number' },
                description: 'Step numbers (1-based) that must succeed first.',
              },
            },
            required: ['title', 'instruction'],
          },
        },
      },
      required: ['mission_id', 'steps'],
    },
  },
  {
    name: 'mission_step_complete',
    description:
      'Report the outcome of the mission step you were given. Always call this. On failure, ' +
      'state exactly what you tried and why it did not work — the retry receives this and ' +
      'must not repeat it.',
    inputSchema: {
      type: 'object',
      properties: {
        step_id: { type: 'string' },
        status: { type: 'string', enum: ['succeeded', 'failed', 'blocked'] },
        result: { type: 'string', description: 'What you accomplished, concretely.' },
        failures: { type: 'string', description: 'On failure: what was tried and why it failed.' },
      },
      required: ['step_id', 'status'],
    },
  },
  {
    name: 'mission_add_step',
    description:
      'Insert a step the original plan missed — a dependency you discovered, a tool that ' +
      'needs installing first. Use this instead of silently doing extra work, so the plan ' +
      'stays an accurate record of what the mission actually required.',
    inputSchema: {
      type: 'object',
      properties: {
        mission_id: { type: 'string' },
        title: { type: 'string' },
        instruction: { type: 'string' },
        kind: { type: 'string', enum: ['research', 'provision', 'work', 'verify', 'report'] },
        before_seq: {
          type: 'number',
          description: 'Insert before this step number. Omit to append at the end.',
        },
      },
      required: ['mission_id', 'title', 'instruction'],
    },
  },
  {
    name: 'mission_status',
    description: 'Read a mission: its objective, plan, progress, and what has failed so far.',
    inputSchema: {
      type: 'object',
      properties: { mission_id: { type: 'string' } },
      required: ['mission_id'],
    },
  },
  {
    name: 'action_claim',
    description:
      'Claim an irreversible external action BEFORE performing it — sending a message, ' +
      'opening a PR, deploying, deleting, changing DNS, spending money. Returns ' +
      'proceed:true only if you are the one who should do it. If proceed is false the ' +
      'action already happened or someone else holds it, and you MUST NOT repeat it. ' +
      'Sessions can be resumed or moved between models, so anything with an external ' +
      'side effect can otherwise run twice.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description:
            'Stable id derived from the intent, not random — e.g. "pr:simba:add-login" ' +
            'or "dm:instagram:12345". A retry must produce the same key.',
        },
        action_class: {
          type: 'string',
          enum: ['send', 'publish', 'deploy', 'purchase', 'delete', 'external_write', 'dns', 'billing'],
        },
        target: { type: 'string', description: 'What it acts on, e.g. "github:owner/repo".' },
        summary: { type: 'string' },
        params: { type: 'object' },
      },
      required: ['key', 'action_class', 'target'],
    },
  },
  {
    name: 'action_complete',
    description:
      'Record the outcome of a claimed action. Always call this, including on failure — ' +
      'an action left in flight blocks its retry and gets surfaced for human attention.',
    inputSchema: {
      type: 'object',
      properties: {
        action_id: { type: 'string' },
        status: { type: 'string', enum: ['succeeded', 'failed', 'abandoned'] },
        receipt: { type: 'object', description: 'Proof from the far side: message id, PR number, deployment id.' },
        external_id: { type: 'string' },
        error: { type: 'string' },
      },
      required: ['action_id', 'status'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  const { name } = req.params;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case 'doc_read': {
        const scope = (args.scope as string) ?? 'agent';
        const row = await one<{ content: string; revision: number; title: string | null }>(
          `SELECT dr.content, dr.revision, d.title
             FROM documents d
             JOIN document_revisions dr
               ON dr.document_id = d.id AND dr.revision = d.current_revision
            WHERE d.slug = $1 AND d.scope = $2
              AND ($3::uuid IS NULL OR d.agent_id = $3::uuid OR d.agent_id IS NULL)`,
          [args.slug, scope, scope === 'agent' ? AGENT_ID : null],
        );
        if (!row) return text(`No document "${args.slug}" in scope "${scope}".`);
        return text(`# ${row.title ?? args.slug} (revision ${row.revision})\n\n${row.content}`);
      }

      case 'doc_write': {
        const scope = (args.scope as string) ?? 'agent';
        const result = await transaction(async (client) => {
          const existing = await client.query<{ id: string; current_revision: number }>(
            `SELECT id, current_revision FROM documents
              WHERE slug = $1 AND scope = $2
                AND coalesce(agent_id, '00000000-0000-0000-0000-000000000000'::uuid)
                  = coalesce($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
            [args.slug, scope, scope === 'agent' ? AGENT_ID : null],
          );

          let docId: string;
          let revision: number;

          if (existing.rows.length > 0) {
            docId = existing.rows[0]!.id;
            revision = existing.rows[0]!.current_revision + 1;
            await client.query(
              `UPDATE documents SET current_revision = $2, updated_at = now(),
                      title = COALESCE($3, title)
                WHERE id = $1`,
              [docId, revision, args.title ?? null],
            );
          } else {
            revision = 1;
            const created = await client.query<{ id: string }>(
              `INSERT INTO documents (slug, kind, scope, agent_id, session_id, title, current_revision)
               VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING id`,
              [
                args.slug,
                (args.kind as string) ?? 'note',
                scope,
                scope === 'agent' ? AGENT_ID : null,
                scope === 'session' ? SESSION_ID : null,
                args.title ?? args.slug,
              ],
            );
            docId = created.rows[0]!.id;
          }

          await client.query(
            `INSERT INTO document_revisions
               (document_id, revision, content, summary, author_agent_id, author_session_id)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [docId, revision, args.content, args.summary ?? null, AGENT_ID, SESSION_ID],
          );

          return { docId, revision };
        });

        return text(`Saved "${args.slug}" as revision ${result.revision}.`);
      }

      case 'doc_list': {
        const rows = await query(
          `SELECT d.slug, d.kind, d.scope, d.title, d.current_revision, d.updated_at
             FROM documents d
            WHERE NOT d.archived
              AND ($1::text IS NULL OR d.kind = $1)
              AND (d.scope <> 'agent' OR d.agent_id = $2::uuid OR d.agent_id IS NULL)
            ORDER BY d.updated_at DESC
            LIMIT $3`,
          [(args.kind as string) ?? null, AGENT_ID, (args.limit as number) ?? 50],
        );
        return json(rows);
      }

      case 'roster_list': {
        const rows = await query(
          `SELECT a.slug, a.name, a.tier, a.domain, a.status, a.model_tier,
                  p.slug AS project,
                  (SELECT count(*) FROM sessions s
                    WHERE s.agent_id = a.id AND s.status IN ('running','idle')) AS active_sessions,
                  (SELECT s.title FROM sessions s
                    WHERE s.agent_id = a.id ORDER BY s.created_at DESC LIMIT 1) AS latest_session
             FROM agents a
             LEFT JOIN projects p ON p.id = a.project_id
            WHERE a.retired_at IS NULL
            ORDER BY a.tier, a.slug`,
        );
        return json(rows);
      }

      case 'session_search': {
        const rows = await query(
          `SELECT m.session_id, a.slug AS agent, m.role,
                  left(m.content, 400) AS excerpt, m.created_at
             FROM messages m
             JOIN sessions s ON s.id = m.session_id
             JOIN agents a ON a.id = s.agent_id
            WHERE m.content ILIKE '%' || $1 || '%'
              AND ($2::text IS NULL OR a.slug = $2)
            ORDER BY m.created_at DESC
            LIMIT $3`,
          [args.q, (args.agent as string) ?? null, (args.limit as number) ?? 20],
        );
        return json(rows);
      }

      case 'knowledge_search': {
        const hits = await recall(String(args.q), {
          limit: (args.limit as number) ?? 8,
        });
        if (hits.length === 0) {
          return text(
            'No semantic matches. The vector index may not be populated yet — ' +
              'try session_search for a literal text match.',
          );
        }
        return json(
          hits.map((h) => ({
            source: h.source,
            title: h.title,
            relevance: Number((1 - h.distance).toFixed(3)),
            content: h.content.slice(0, 1200),
          })),
        );
      }

      case 'memory_add': {
        const result = await addMemory({
          kind: String(args.kind) as 'environment' | 'preference' | 'convention' | 'person',
          content: String(args.content),
          source: args.source ? String(args.source) : 'learned while working',
          agentId: args.mine_only ? AGENT_ID : null,
          sessionId: SESSION_ID,
        });
        if (!result.ok) return text(`Not remembered: ${result.error}`);
        const p = await memoryPressure(AGENT_ID);
        return text(
          `Remembered. Memory is now ${p.global.used}/${p.global.cap} shared` +
            `, ${p.own.used}/${p.own.cap} yours.`,
        );
      }

      case 'memory_remove': {
        const r = await removeMemory(String(args.match), AGENT_ID);
        return text(
          r.removed > 0 ? `Forgot: ${r.content}` : `No memory matched "${String(args.match)}".`,
        );
      }

      case 'learn': {
        const from = String(args.from ?? 'session');
        let source;
        if (from === 'text') {
          if (!args.text) return text('learn(from:"text") needs text.');
          source = { from: 'text' as const, text: String(args.text) };
        } else if (from === 'url') {
          if (!args.url) return text('learn(from:"url") needs a url.');
          source = { from: 'url' as const, url: String(args.url) };
        } else if (from === 'path') {
          if (!args.path) return text('learn(from:"path") needs a path.');
          source = { from: 'path' as const, path: String(args.path) };
        } else {
          const sid = args.session_id ? String(args.session_id) : SESSION_ID;
          if (!sid) return text('No session to learn from.');
          source = { from: 'session' as const, sessionId: sid };
        }

        const r = await learn(source, { sessionId: SESSION_ID });
        if (!r.learned) return text(`Nothing learned: ${r.reason}`);
        return text(
          r.created
            ? `Learned a new skill: ${r.name}. It is in every agent's index from now on.`
            : `Updated skill ${r.name} to v${r.version}. The previous version is kept.`,
        );
      }

      case 'skill_view': {
        const skill = await viewSkill(String(args.name));
        if (!skill) {
          // Names are guessable and models guess. Listing what does exist turns
          // a dead end into a usable answer.
          const available = await listSkills();
          return text(
            `No skill named "${String(args.name)}". Available: ` +
              (available.map((s) => s.name).join(', ') || '(none)'),
          );
        }
        return text(
          `# ${skill.name} (v${skill.version})\n${skill.description}\n\n${skill.body}`,
        );
      }

      case 'skill_list': {
        const all = await listSkills();
        if (all.length === 0) return text('No skills recorded yet.');
        return text(
          all
            .map((s) => `- ${s.name} (used ${s.use_count}×) — ${s.description}`)
            .join('\n'),
        );
      }

      case 'skill_save': {
        const result = await saveSkill({
          name: String(args.name),
          description: String(args.description),
          body: String(args.body),
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
          note: args.note ? String(args.note) : undefined,
          sessionId: SESSION_ID,
          source: 'learned',
        });
        return text(
          result.created
            ? `Skill "${result.name}" created.`
            : `Skill "${result.name}" revised to v${result.version}. Previous version kept.`,
        );
      }

      case 'note_append': {
        await query(
          `INSERT INTO messages (session_id, turn_id, agent_id, seq, role, content)
           VALUES ($1, NULL, $2,
                   COALESCE((SELECT max(seq) FROM messages WHERE session_id = $1), 0) + 1,
                   'system', $3)`,
          [SESSION_ID, AGENT_ID, `[note] ${String(args.note)}`],
        );
        return text('Noted.');
      }

      case 'agent_message': {
        const target = await one<{ id: string; slug: string }>(
          `SELECT id, slug FROM agents WHERE slug = $1 AND retired_at IS NULL`,
          [args.to],
        );
        if (!target) return text(`No agent with slug "${args.to}". Use roster_list.`);

        // A reply inherits its parent's correlation and advances the hop count.
        // Without this every message starts a fresh chain at hop zero, and the
        // router can never distinguish an ongoing conversation from two agents
        // asking each other the same thing indefinitely.
        const parent = args.reply_to
          ? await one<{ correlation_id: string; hop_count: number }>(
              `SELECT correlation_id, hop_count FROM inboxes WHERE id = $1`,
              [args.reply_to],
            )
          : null;

        await query(
          `INSERT INTO inboxes
             (from_agent_id, to_agent_id, intent, payload, wake_target,
              correlation_id, parent_message_id, hop_count)
           VALUES ($1,$2,$3,$4,$5,
                   coalesce($6::uuid, gen_random_uuid()), $7, $8)`,
          [
            AGENT_ID,
            target.id,
            args.intent,
            JSON.stringify(args.payload ?? {}),
            Boolean(args.wake),
            parent?.correlation_id ?? null,
            args.reply_to ?? null,
            (parent?.hop_count ?? -1) + 1,
          ],
        );
        await recordEvent({
          type: 'inbox.sent',
          agentId: AGENT_ID,
          sessionId: SESSION_ID,
          message: `message to ${target.slug}: ${String(args.intent)}`,
        });
        return text(`Queued for ${target.slug}.`);
      }

      case 'inbox_read': {
        const rows = await query(
          `SELECT i.id, a.slug AS from_agent, i.intent, i.payload, i.created_at
             FROM inboxes i
             LEFT JOIN agents a ON a.id = i.from_agent_id
            WHERE i.to_agent_id = $1 AND i.status = 'pending'
            ORDER BY i.priority, i.created_at`,
          [AGENT_ID],
        );
        if (rows.length > 0) {
          await query(
            `UPDATE inboxes SET status = 'delivered', delivered_at = now()
              WHERE to_agent_id = $1 AND status = 'pending'`,
            [AGENT_ID],
          );
        }
        return json(rows);
      }

      case 'mission_plan': {
        const steps = (args.steps ?? []) as Array<Record<string, unknown>>;
        if (steps.length === 0) return text('No steps supplied.');

        // Refuse to replan over work that has already happened.
        //
        // This handler deletes every mission_steps row and reinserts from
        // scratch, which is right for a planning session writing the first plan
        // and destructive for anything else. Those rows carry `result`,
        // `failures`, `attempts` and the session that ran them - the record of
        // what was tried and what did not work. Deleting it does not just lose
        // history, it removes the thing that stops the next attempt walking
        // straight back into the same dead end, which is the entire point of
        // keeping failures.
        //
        // Any agent can call this with any mission id, and an autonomous one
        // that decides to rethink a stuck mission is exactly the caller that
        // would reach for it. So the guard is on started work rather than on
        // status: a plan nobody has begun is fine to replace.
        const started = await one<{ n: number }>(
          `SELECT count(*)::int AS n FROM mission_steps
            WHERE mission_id = $1 AND status <> 'pending'`,
          [args.mission_id],
        );
        if ((started?.n ?? 0) > 0) {
          return text(
            `Refusing to replan: ${started?.n} step(s) on this mission have already run, and ` +
            `replanning deletes every step including their results and recorded failures. ` +
            `Use mission_add_step to add work, or mission_step_complete to close out what is ` +
            `still open.`,
          );
        }

        await transaction(async (client) => {
          await client.query(`DELETE FROM mission_steps WHERE mission_id = $1`, [args.mission_id]);
          let seq = 0;
          for (const s of steps) {
            seq += 1;
            await client.query(
              `INSERT INTO mission_steps (mission_id, seq, title, instruction, kind, depends_on)
               VALUES ($1,$2,$3,$4,$5,$6)`,
              [
                args.mission_id,
                seq,
                String(s.title ?? `step ${seq}`),
                String(s.instruction ?? ''),
                String(s.kind ?? 'work'),
                Array.isArray(s.depends_on) ? (s.depends_on as number[]) : [],
              ],
            );
          }
          // Planning is finished the moment the plan exists; the executor picks
          // it up on the next tick without needing to be told. Clearing the
          // failure counter matters because planning is optimistically counted
          // as a failure until a plan actually lands.
          await client.query(
            `UPDATE missions
                SET status = 'running', consecutive_failures = 0,
                    planning_session_id = NULL, updated_at = now()
              WHERE id = $1`,
            [args.mission_id],
          );
        });

        await query(
          `INSERT INTO mission_log (mission_id, message) VALUES ($1,$2)`,
          [args.mission_id, `plan recorded: ${steps.length} steps`],
        );
        return text(`Plan recorded (${steps.length} steps). The mission is now running.`);
      }

      case 'mission_step_complete': {
        const status = String(args.status);
        const step = await one<{ mission_id: string; seq: number; title: string }>(
          `UPDATE mission_steps
              SET status = $2, result = $3, failures = COALESCE($4, failures),
                  completed_at = now()
            WHERE id = $1
        RETURNING mission_id, seq, title`,
          [args.step_id, status === 'blocked' ? 'failed' : status,
           args.result ?? null, args.failures ?? null],
        );
        if (!step) return text('Unknown step id.');

        // Consecutive failures drive the circuit breaker, so a success has to
        // reset it — otherwise a mission that recovers still trips eventually.
        await query(
          status === 'succeeded'
            ? `UPDATE missions SET consecutive_failures = 0, updated_at = now() WHERE id = $1`
            : `UPDATE missions SET consecutive_failures = consecutive_failures + 1,
                                   updated_at = now() WHERE id = $1`,
          [step.mission_id],
        );
        await query(
          `INSERT INTO mission_log (mission_id, step_id, level, message)
           VALUES ($1,$2,$3,$4)`,
          [step.mission_id, args.step_id, status === 'succeeded' ? 'info' : 'warn',
           `step ${step.seq} "${step.title}" ${status}`],
        );
        return text(`Recorded step ${step.seq} as ${status}.`);
      }

      case 'mission_add_step': {
        const before = args.before_seq ? Number(args.before_seq) : null;
        const seq = await transaction(async (client) => {
          if (before !== null) {
            // Shift later steps down. depends_on holds step numbers, so those
            // references have to move with them or the plan's ordering breaks.
            await client.query(
              `UPDATE mission_steps SET seq = seq + 1
                WHERE mission_id = $1 AND seq >= $2`,
              [args.mission_id, before],
            );
            await client.query(
              `UPDATE mission_steps
                  SET depends_on = ARRAY(SELECT CASE WHEN d >= $2 THEN d + 1 ELSE d END
                                           FROM unnest(depends_on) AS d)
                WHERE mission_id = $1`,
              [args.mission_id, before],
            );
            return before;
          }
          const max = await client.query<{ m: number }>(
            `SELECT coalesce(max(seq), 0) AS m FROM mission_steps WHERE mission_id = $1`,
            [args.mission_id],
          );
          return (max.rows[0]?.m ?? 0) + 1;
        });

        await query(
          `INSERT INTO mission_steps (mission_id, seq, title, instruction, kind)
           VALUES ($1,$2,$3,$4,$5)`,
          [args.mission_id, seq, args.title, args.instruction, args.kind ?? 'work'],
        );
        await query(
          `INSERT INTO mission_log (mission_id, message) VALUES ($1,$2)`,
          [args.mission_id, `step inserted at ${seq}: ${String(args.title)}`],
        );

        // Adding a step to a finished mission means it is not finished.
        //
        // Without this the row keeps status 'completed' while holding pending
        // steps, and runnable_steps only considers missions that are running -
        // so the step is invisible to the executor and the mission's own status
        // contradicts its contents. That happened twice tonight to this
        // repository's own worklog mission.
        //
        // Only from completed, and only because the caller has just said there
        // is more to do. A blocked or cancelled mission stays where it is:
        // those were stopped for a reason that adding a step does not answer.
        const reopened = await query<{ id: string }>(
          `UPDATE missions SET status = 'running', completed_at = NULL, updated_at = now()
            WHERE id = $1 AND status = 'completed' RETURNING id`,
          [args.mission_id],
        );
        return text(
          reopened.length > 0
            ? `Added step ${seq}. The mission was completed, so it has been reopened.`
            : `Added step ${seq}.`,
        );
      }

      case 'mission_status': {
        const mission = await one(
          `SELECT title, objective, acceptance_criteria, status, sessions_used, max_sessions,
                  round(cost_used_usd,4) AS cost_used, max_cost_usd, consecutive_failures
             FROM missions WHERE id = $1`,
          [args.mission_id],
        );
        if (!mission) return text('Unknown mission id.');
        const steps = await query(
          `SELECT seq, title, kind, status, attempts,
                  left(coalesce(result,''), 200) AS result,
                  left(coalesce(failures,''), 300) AS failures
             FROM mission_steps WHERE mission_id = $1 ORDER BY seq`,
          [args.mission_id],
        );
        return json({ mission, steps });
      }

      case 'action_claim': {
        // Surface policy is checked before the idempotency claim: an action the
        // originating surface may not perform should never occupy a key.
        const origin = await one<{ origin_surface_id: string | null }>(
          `SELECT origin_surface_id FROM sessions WHERE id = $1`,
          [SESSION_ID],
        );
        // A session with no recorded surface falls back to the most restrictive
        // one, never to "unchecked". Previously this was `if (surface) {...}`,
        // so a NULL origin skipped every check — and NULL is exactly what an
        // auto-resumed session used to come back with.
        const surface =
          (origin?.origin_surface_id
            ? await one<Surface>(`SELECT * FROM surfaces WHERE id = $1`, [origin.origin_surface_id])
            : null) ?? (await one<Surface>(`SELECT * FROM surfaces WHERE slug = 'automation'`));

        if (surface) {
          const verdict = await checkAction(surface, String(args.action_class));
          if (!verdict.allowed) {
            await logDenial(surface, String(args.action_class), verdict.reason ?? '');
            return json({
              proceed: false,
              reason: verdict.reason,
              note: 'Blocked by surface policy. Report this rather than working around it.',
            });
          }
          if (verdict.needsConfirmation) {
            await query(
              `INSERT INTO actions (idempotency_key, action_class, target, summary, params,
                                    agent_id, session_id, origin_surface_id, status)
               VALUES ($1,$2,$3,$4,$5,$6::uuid,$7::uuid,$8::uuid,'needs_confirmation')
               ON CONFLICT (idempotency_key) DO NOTHING`,
              [args.key, args.action_class, args.target, args.summary ?? null,
               JSON.stringify(args.params ?? {}), AGENT_ID, SESSION_ID, surface.id],
            );
            return json({
              proceed: false,
              status: 'needs_confirmation',
              note:
                `Actions of class "${String(args.action_class)}" from the ${surface.slug} surface ` +
                `require confirmation. It is queued; tell the operator it is waiting and move on.`,
            });
          }
        }

        const row = await one<{ action_id: string; is_new: boolean; current_status: string }>(
          `SELECT * FROM claim_action($1,$2,$3,$4,$5,$6::uuid,$7::uuid)`,
          [
            args.key,
            args.action_class,
            args.target,
            args.summary ?? null,
            JSON.stringify(args.params ?? {}),
            AGENT_ID,
            SESSION_ID,
          ],
        );
        if (!row) return text('Could not claim action.');

        if (row.is_new) {
          return json({
            proceed: true,
            action_id: row.action_id,
            note: 'You hold this action. Perform it, then call action_complete.',
          });
        }
        return json({
          proceed: false,
          action_id: row.action_id,
          status: row.current_status,
          note:
            row.current_status === 'succeeded'
              ? 'Already completed successfully. Do not repeat it; treat it as done.'
              : 'Already claimed or resolved elsewhere. Do not repeat it.',
        });
      }

      case 'action_complete': {
        await query(`SELECT complete_action($1::uuid,$2,$3::jsonb,$4,$5)`, [
          args.action_id,
          args.status,
          args.receipt ? JSON.stringify(args.receipt) : null,
          args.external_id ?? null,
          args.error ?? null,
        ]);
        return text(`Recorded ${String(args.status)}.`);
      }

      default:
        return text(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Simba tool error: ${message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
