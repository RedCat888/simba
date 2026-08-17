import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from '../config.js';
import { query, one, recordEvent } from '../db/index.js';
import { SessionManager } from '../session/manager.js';
import { Supervisor } from '../supervisor/index.js';
import { recall, embeddingFailure } from '../knowledge/embed.js';
import { askDecisions } from '../knowledge/decisions.js';
import { verifyBrain } from '../runner/verify.js';
import { captureSessionDiff } from '../hydration/git.js';
import { unreapedWorktrees } from '../session/worktree.js';
import { scanProjects } from '../inventory/scan.js';
import { allowedRoots, confine, listDir, readTextFile } from '../inventory/files.js';
import { transcribe, speak, classify, voiceAvailable, workerStatus } from '../voice/index.js';
import { learn } from '../knowledge/learn.js';
import { measureContext } from '../hydration/budget.js';
import { curate, storePressure } from '../knowledge/curator.js';
import { listMemory, addMemory, removeMemory, memoryPressure } from '../knowledge/memory.js';
import { parseSchedule } from '../missions/schedule.js';
import {
  canReachAgent,
  clampModelTier,
  getSurface,
  logDenial,
  type Surface,
} from '../policy/surface.js';
import {
  authenticate,
  channelOf,
  describePrincipal,
  hostAllowed,
  originAllowed,
  type Channel,
} from '../policy/identity.js';
import { prewarmAccess, type Principal } from '../policy/access.js';

type Vars = { surface: Surface; channel: Channel; principal: Principal | null };

/**
 * The authenticated surface for this request.
 *
 * Authentication happens once in middleware, so by the time any route runs the
 * surface is already established and cannot be null. Routes previously each
 * resolved it themselves from headers, which is what allowed several of them to
 * forget and fail open.
 */
function surfaceOf(c: { get: (k: 'surface') => Surface }): Surface {
  return c.get('surface');
}

/** Clamps a caller-supplied page size so a read endpoint cannot become a bulk export. */
function capLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * The gateway: HTTP for state and commands, websockets for live output.
 *
 * Bound to loopback by design — reachability from the phone comes from a
 * Cloudflare Tunnel in front of this, never from opening a port.
 */

const manager = new SessionManager();
const supervisor = new Supervisor(manager);
const app = new Hono<{ Variables: Vars }>();

const sockets = new Set<WebSocket>();

function broadcast(payload: unknown): void {
  const text = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(text);
  }
}

manager.on('event', (e) => broadcast({ type: 'session_event', ...e }));
manager.on('swapped', (e) => broadcast({ type: 'brain_swapped', ...e }));
manager.on('exhausted', (e) => broadcast({ type: 'exhausted', ...e }));

/**
 * Default-deny authentication for every route.
 *
 * Scoped to `*`, not `/api/*`: the UI route and anything added later were
 * previously uncovered simply by not matching the pattern, which is the kind of
 * gap that reappears every time a route is added.
 */
app.use('*', async (c, next) => {
  const headers = c.req.header() as Record<string, string | undefined>;
  const socket = (c.env as { incoming?: { socket?: { localPort?: number } } })?.incoming?.socket;
  const channel = channelOf(socket?.localPort);

  if (!hostAllowed(channel, headers.host)) {
    return c.json({ error: 'bad host' }, 403);
  }
  if (!originAllowed(channel, headers.origin)) {
    return c.json({ error: 'bad origin' }, 403);
  }

  const auth = await authenticate(channel, headers);
  if (!auth.ok) return c.json({ error: auth.reason }, auth.status);

  c.set('surface', auth.surface);
  c.set('channel', auth.channel);
  c.set('principal', auth.principal);
  return next();
});

// ---------------------------------------------------------------------------
// Roster and state
// ---------------------------------------------------------------------------

app.get('/api/agents', async (c) => {
  const rows = await query(
    `SELECT a.id, a.slug, a.name, a.tier, a.domain, a.description, a.status,
            a.model_tier, a.last_active_at,
            p.slug AS project,
            (SELECT count(*)::int FROM sessions s
              WHERE s.agent_id = a.id AND s.status IN ('running','idle')) AS active_sessions,
            (SELECT coalesce(sum(s.total_cost_usd), 0) FROM sessions s
              WHERE s.agent_id = a.id) AS total_cost
       FROM agents a
       LEFT JOIN projects p ON p.id = a.project_id
      WHERE a.retired_at IS NULL
      ORDER BY a.tier, a.slug`,
  );
  return c.json(rows);
});

app.get('/api/brains', async (c) => {
  const rows = await query(
    `SELECT b.id, b.slug, b.label, b.provider, b.cli, b.status, b.priority, b.enabled,
            b.limit_resets_at, b.last_error,
            u.input_5h, u.output_5h, u.cost_5h, u.input_7d, u.output_7d, u.cost_7d
       FROM brain_accounts b
       LEFT JOIN usage_windows u ON u.brain_account_id = b.id
      ORDER BY b.priority`,
  );
  return c.json(rows);
});

/**
 * The brains a non-Simba process should try, best first.
 *
 * Simba's own runners pick a brain through the router and fail over when one
 * hits its limit. ReelAgent — the Instagram intake — spawns `claude -p` itself
 * and had no idea any of that existed, so it used whatever account the CLI
 * defaults to. When that account hit its limit, every reel came back with a
 * usage-limit message as its "answer", and it stayed that way until the window
 * rolled over. Reels went unread for a whole evening that way.
 *
 * Exposing the chain rather than a single choice is deliberate: the caller
 * spawns the CLI itself and so is the only thing that can tell a limit message
 * from a real answer, which makes it the only thing that can decide to move on
 * to the next one.
 *
 * `config_dir` is the whole mechanism — account isolation for the Claude CLI is
 * entirely CLAUDE_CONFIG_DIR, so handing it over is handing over the account.
 * Loopback and Access-guarded, same as everything else here.
 */
app.get('/api/brains/chain', async (c) => {
  const cli = c.req.query('cli') ?? 'claude';
  const rows = await query(
    `SELECT slug, label, cli, config_dir, status, priority
       FROM brain_accounts
      WHERE enabled
        AND cli = $1
        AND status IN ('available', 'unverified')
        -- A limit that has already rolled over is not a limit any more. Without
        -- this an account stays benched long after it recovered.
        AND (status <> 'limited' OR limit_resets_at IS NULL OR limit_resets_at <= now())
      ORDER BY priority`,
    [cli],
  );
  return c.json(rows);
});

/**
 * Isolated checkouts holding work nobody has collected.
 *
 * A worktree is kept rather than deleted whenever it still contains changes,
 * which is the right call — destroying what an agent produced unattended is not
 * recoverable. But kept-and-invisible is its own failure: the session list says
 * "completed" while a directory somewhere holds the only copy of the work. This
 * is how that stays visible.
 */
app.get('/api/worktrees', async (c) => {
  const pending = await unreapedWorktrees();
  return c.json(pending);
});

/**
 * What a session actually changed.
 *
 * The premise of this system is work happening while nobody watches, and until
 * now the only record of what an agent did to the filesystem was a diffstat
 * line. Seeing eleven files touched and not what changed in them is the wrong
 * half to have. Reviewing the diff from the phone is what turns unattended work
 * into work you can trust.
 */
app.get('/api/sessions/:id/diff', async (c) => {
  const session = await one<{ cwd: string | null; worktree_path: string | null; started_at: Date }>(
    `SELECT cwd, worktree_path, started_at FROM sessions WHERE id = $1`,
    [c.req.param('id')],
  );
  if (!session) return c.json({ error: 'no such session' }, 404);

  const dir = session.worktree_path ?? session.cwd;
  if (!dir) return c.json({ error: 'session has no working directory' }, 404);

  const diff = await captureSessionDiff(dir, {
    since: session.started_at ? session.started_at.toISOString() : null,
  });
  if (!diff) return c.json({ error: 'not a git repository' }, 404);
  return c.json(diff);
});

/**
 * Skills, for the phone.
 *
 * The list returns descriptions and usage but never bodies — the same
 * discipline the system prompt follows, and for a related reason: a phone
 * scrolling a list does not want kilobytes of markdown per row.
 */
/**
 * Turn something into a skill, from the phone.
 *
 * The MCP tool covers an agent learning mid-work. This covers the other half:
 * pointing Simba at a session that solved something, a documentation page, or a
 * procedure worth keeping, without needing an agent running to ask.
 */
/**
 * Where an agent's context window goes, by category.
 *
 * The brief has grown all night - memory, a skills index, summaries,
 * checkpoints, git state, recall - each addition individually justified with
 * nothing measuring the total. A single number tells you that you are in
 * trouble; a breakdown tells you what to cut.
 */
/**
 * What the always-loaded stores cost, and a way to tidy them.
 *
 * GET reports pressure; POST runs curation. Curation also runs on its own
 * schedule — this exists so it can be inspected and forced rather than only
 * happening invisibly.
 */
/**
 * Memory, for the phone.
 *
 * The MCP tools cover an agent editing its own memory. These cover the operator
 * reading and correcting it, which matters more: memory is loaded on every turn
 * of every session, so a wrong entry is wrong everywhere until someone removes
 * it, and until now the only way to see it was to query Postgres.
 */
app.get('/api/memory', async (c) => {
  const rows = await listMemory(null);
  const pressure = await memoryPressure(null);
  return c.json({ entries: rows, pressure });
});

app.post('/api/memory', async (c) => {
  const b = await c.req.json<{ kind?: string; content?: string; source?: string }>();
  if (!b.content) return c.json({ error: 'content required' }, 400);
  const result = await addMemory({
    kind: (b.kind ?? 'environment') as 'environment' | 'preference' | 'convention' | 'person',
    content: b.content,
    source: b.source ?? 'added from the app',
  });
  if (!result.ok) return c.json({ error: result.error }, 409);
  return c.json({ ok: true, pressure: await memoryPressure(null) });
});

app.delete('/api/memory', async (c) => {
  const match = c.req.query('match');
  if (!match) return c.json({ error: 'match required' }, 400);
  const r = await removeMemory(match, null);
  return c.json(r);
});

app.get('/api/curation', async (c) => {
  return c.json(await storePressure());
});

app.post('/api/curation', async (c) => {
  const result = await curate({
    skillIdleDays: Number(c.req.query('idleDays') ?? 30),
  });
  return c.json(result);
});

app.get('/api/agents/:slug/context', async (c) => {
  const budget = await measureContext(c.req.param('slug'), {
    sessionId: c.req.query('session') ?? null,
  });
  if (!budget) return c.json({ error: 'no such agent' }, 404);
  return c.json(budget);
});

app.post('/api/learn', async (c) => {
  const b = await c.req.json<{
    from?: 'session' | 'text' | 'url' | 'path';
    text?: string;
    url?: string;
    path?: string;
    sessionId?: string;
  }>();

  const from = b.from ?? 'session';
  try {
    let source;
    if (from === 'text' && b.text) source = { from: 'text' as const, text: b.text };
    else if (from === 'url' && b.url) source = { from: 'url' as const, url: b.url };
    else if (from === 'path' && b.path) source = { from: 'path' as const, path: b.path };
    else if (b.sessionId) source = { from: 'session' as const, sessionId: b.sessionId };
    else return c.json({ error: `learn(from:"${from}") is missing its input` }, 400);

    const result = await learn(source, { sessionId: b.sessionId ?? null });
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get('/api/skills', async (c) => {
  const rows = await query(
    `SELECT name, description, tags, source, version, use_count, last_used_at, updated_at,
            length(body) AS body_chars
       FROM skills
      WHERE enabled
      ORDER BY use_count DESC, name`,
  );
  return c.json(rows);
});

app.get('/api/skills/:name', async (c) => {
  const row = await one(
    `SELECT name, description, body, tags, related, source, version, use_count,
            last_used_at, created_at, updated_at
       FROM skills WHERE name = $1`,
    [c.req.param('name')],
  );
  if (!row) return c.json({ error: 'no such skill' }, 404);

  const history = await query(
    `SELECT r.version, r.note, r.created_at
       FROM skill_revisions r JOIN skills s ON s.id = r.skill_id
      WHERE s.name = $1 ORDER BY r.version DESC LIMIT 20`,
    [c.req.param('name')],
  );
  return c.json({ ...row, history });
});

/**
 * Ask a brain whether it works, right now.
 *
 * This exists because two working subscriptions sat benched for days behind a
 * stale status: cursor was marked logged_out when the real fault was a model id
 * that did not exist in its catalog. A status is a claim about whenever
 * something last changed it, so the phone needs a way to force the question
 * rather than trust the record.
 */
app.post('/api/brains/:slug/verify', async (c) => {
  const slug = c.req.param('slug');
  const brain = await one<{ id: string; cli: string; tier_models: Record<string, string> }>(
    `SELECT id, cli, tier_models FROM brain_accounts WHERE slug = $1`,
    [slug],
  );
  if (!brain) return c.json({ error: 'no such brain' }, 404);

  const result = await verifyBrain(slug);

  // A rate limit is not a broken account, and recording it as one is how a
  // perfectly good brain stays benched. 'limited' is the status the supervisor
  // already knows how to undo: it clears the moment the reset passes and parked
  // sessions resume on their own. 'error' has no such path back and waits for a
  // person — which is right for auth and for a CLI that will not answer, and
  // wrong for the one failure that fixes itself.
  //
  // Without a reset timestamp from the CLI, give it an hour. Claude's windows
  // are five hours, so an hour is a re-check rather than a guess at the answer:
  // if it is still limited the next verify says so, and if it recovered early
  // the brain is back rather than waiting out a window that already rolled.
  const status = result.ok ? 'available' : result.failure === 'limited' ? 'limited' : 'error';
  const resetsAt =
    status === 'limited' ? new Date(Date.now() + 60 * 60_000).toISOString() : null;
  await query(
    `UPDATE brain_accounts
        SET status = $2, last_error = $3, limit_resets_at = $4,
            last_checked_at = now(), updated_at = now()
      WHERE id = $1`,
    [brain.id, status, result.detail, resetsAt],
  );
  await recordEvent({
    type: 'brain.verified',
    severity: result.ok ? 'info' : 'warn',
    message: `${slug}: ${result.ok ? 'available' : 'failed'}`,
    data: { slug, detail: result.detail, ms: result.ms },
  });
  return c.json({ slug, ...result });
});

/** Bench a brain, or bring one back. */
app.post('/api/brains/:slug/toggle', async (c) => {
  const row = await one<{ enabled: boolean }>(
    `UPDATE brain_accounts SET enabled = NOT enabled, updated_at = now()
      WHERE slug = $1 RETURNING enabled`,
    [c.req.param('slug')],
  );
  if (!row) return c.json({ error: 'no such brain' }, 404);
  await recordEvent({
    type: 'brain.toggled',
    severity: 'info',
    message: `${c.req.param('slug')} ${row.enabled ? 'enabled' : 'disabled'}`,
  });
  return c.json({ enabled: row.enabled });
});

app.get('/api/sessions', async (c) => {
  const rows = await query(
    // s.error included deliberately: a session showing "failed" with no reason
    // reads as a defect in Simba rather than something that happened to a
    // process, and the reason was already being recorded.
    `SELECT s.id, s.status, s.title, s.description, s.tags, s.cli, s.cwd,
            s.error,
            s.total_cost_usd, s.total_input_tokens, s.total_output_tokens,
            s.swap_count, s.created_at, s.last_activity_at,
            s.hydrated_from_session_id,
            a.slug AS agent, a.name AS agent_name, a.tier,
            b.slug AS brain, p.slug AS project
       FROM sessions s
       JOIN agents a ON a.id = s.agent_id
       LEFT JOIN brain_accounts b ON b.id = s.brain_account_id
       LEFT JOIN projects p ON p.id = s.project_id
      ORDER BY s.last_activity_at DESC NULLS LAST, s.created_at DESC
      LIMIT 200`,
  );
  return c.json(rows);
});

app.get('/api/sessions/:id/messages', async (c) => {
  const rows = await query(
    `SELECT seq, role, content, reasoning, created_at, turn_id
       FROM messages
      WHERE session_id = $1
      ORDER BY seq
      LIMIT 2000`,
    [c.req.param('id')],
  );
  return c.json(rows);
});

app.get('/api/sessions/:id/tools', async (c) => {
  const rows = await query(
    `SELECT name, args, result_text, is_error, duration_ms, created_at
       FROM tool_calls
      WHERE session_id = $1
      ORDER BY created_at
      LIMIT 500`,
    [c.req.param('id')],
  );
  return c.json(rows);
});

app.get('/api/sessions/:id/turns', async (c) => {
  const rows = await query(
    `SELECT t.seq, t.status, t.model, t.model_tier, t.cost_usd,
            t.input_tokens, t.output_tokens, t.duration_ms, t.started_at,
            b.slug AS brain
       FROM turns t
       LEFT JOIN brain_accounts b ON b.id = t.brain_account_id
      WHERE t.session_id = $1
      ORDER BY t.seq`,
    [c.req.param('id')],
  );
  return c.json(rows);
});

app.get('/api/sessions/:id/checkpoints', async (c) => {
  const rows = await query(
    `SELECT id, reason, task_statement, work_done, work_remaining, failures,
            key_decisions, open_questions, git_branch, git_dirty, created_at
       FROM checkpoints WHERE session_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [c.req.param('id')],
  );
  return c.json(rows);
});

app.get('/api/events', async (c) => {
  const rows = await query(
    `SELECT e.id, e.ts, e.type, e.severity, e.message, e.data,
            a.slug AS agent, b.slug AS brain
       FROM events e
       LEFT JOIN agents a ON a.id = e.agent_id
       LEFT JOIN brain_accounts b ON b.id = e.brain_account_id
      ORDER BY e.ts DESC
      LIMIT 200`,
  );
  return c.json(rows);
});

app.get('/api/stats', async (c) => {
  const stats = await one(
    `SELECT
       (SELECT count(*)::int FROM agents WHERE retired_at IS NULL)                      AS agents,
       (SELECT count(*)::int FROM sessions WHERE status IN ('running','idle'))          AS active_sessions,
       (SELECT count(*)::int FROM sessions)                                             AS total_sessions,
       (SELECT count(*)::int FROM messages)                                             AS messages,
       (SELECT count(*)::int FROM tool_calls)                                           AS tool_calls,
       (SELECT count(*)::int FROM knowledge_items)                                      AS knowledge_items,
       (SELECT count(*)::int FROM embeddings)                                           AS embeddings,
       (SELECT coalesce(sum(total_cost_usd), 0) FROM sessions)                          AS total_cost,
       (SELECT count(*)::int FROM brain_accounts WHERE status = 'available')            AS brains_available,
       (SELECT count(*)::int FROM brain_accounts WHERE status = 'limited')              AS brains_limited`,
  );
  return c.json(stats);
});

/**
 * Semantic search over the personal corpus: knowledge base, Obsidian vault, and
 * full Claude/ChatGPT conversation history. This is the payoff of storing
 * everything — being able to ask your own history a question.
 */
app.get('/api/knowledge/search', async (c) => {
  const q = c.req.query('q');
  if (!q) return c.json({ error: 'q required' }, 400);
  // Capped. Uncapped, `?limit=999999` is a one-request dump of the entire
  // personal corpus — the highest-likelihood real loss from a stolen device.
  const hits = await recall(q, { limit: capLimit(c.req.query('limit'), 12, 50) });

  // An empty result has two very different causes and the caller cannot tell
  // them apart from the payload. Ollama being down answered "No matches" to
  // every query for an unknown stretch, which reads as "you have nothing about
  // that" — the opposite of the truth, since there are thirty thousand vectors.
  if (hits.length === 0) {
    const failure = embeddingFailure();
    if (failure) {
      return c.json(
        {
          error: 'search is unavailable',
          detail: `the local embedding model did not answer: ${failure.reason}`,
          fix: 'start Ollama — the gateway reaches it at ' + config.embedding.endpoint,
        },
        503,
      );
    }
  }
  return c.json(
    hits.map((h) => ({
      source: h.source,
      title: h.title,
      relevance: Number((1 - h.distance).toFixed(3)),
      content: h.content.slice(0, 1500),
    })),
  );
});

/**
 * "What did I decide about X" — the question raw semantic search answers badly,
 * because a conversation about a decision is mostly deliberation.
 */
app.get('/api/decisions/ask', async (c) => {
  const q = c.req.query('q');
  if (!q) return c.json({ error: 'q required' }, 400);
  return c.json(await askDecisions(q, capLimit(c.req.query('limit'), 8, 40)));
});

app.get('/api/decisions', async (c) => {
  const rows = await query(
    `SELECT * FROM current_decisions ORDER BY decided_at DESC NULLS LAST LIMIT 100`,
  );
  return c.json(rows);
});

app.get('/api/decisions/stats', async (c) => {
  const row = await one(
    `SELECT
       (SELECT count(*)::int FROM decisions)                            AS total,
       (SELECT count(*)::int FROM decisions WHERE status='current')     AS current,
       (SELECT count(*)::int FROM decisions WHERE status='superseded')  AS superseded,
       (SELECT count(*)::int FROM decision_extractions)                 AS items_scanned,
       (SELECT count(*)::int FROM knowledge_items i JOIN knowledge_sources s ON s.id=i.source_id
         WHERE s.kind IN ('chatgpt_export','claude_export','obsidian')
           AND length(i.content) > 400)                                 AS items_eligible`,
  );
  return c.json(row);
});

app.get('/api/knowledge/sources', async (c) => {
  const rows = await query(
    `SELECT s.slug, s.kind, s.name, s.item_count, s.last_ingested_at,
            (SELECT count(*)::int FROM knowledge_items i WHERE i.source_id = s.id) AS items,
            (SELECT count(*)::int FROM knowledge_chunks ch
               JOIN knowledge_items i2 ON i2.id = ch.item_id
              WHERE i2.source_id = s.id) AS chunks
       FROM knowledge_sources s
      ORDER BY items DESC`,
  );
  return c.json(rows);
});

app.get('/api/documents', async (c) => {
  const rows = await query(
    `SELECT d.id, d.slug, d.kind, d.scope, d.title, d.current_revision, d.updated_at,
            a.slug AS agent
       FROM documents d
       LEFT JOIN agents a ON a.id = d.agent_id
      WHERE NOT d.archived
      ORDER BY d.updated_at DESC LIMIT 100`,
  );
  return c.json(rows);
});

app.get('/api/documents/:id', async (c) => {
  const row = await one(
    `SELECT d.slug, d.title, d.kind, dr.revision, dr.content, dr.created_at,
            a.slug AS author
       FROM documents d
       JOIN document_revisions dr
         ON dr.document_id = d.id AND dr.revision = d.current_revision
       LEFT JOIN agents a ON a.id = dr.author_agent_id
      WHERE d.id = $1`,
    [c.req.param('id')],
  );
  return row ? c.json(row) : c.json({ error: 'not found' }, 404);
});

app.get('/api/inboxes', async (c) => {
  const rows = await query(
    `SELECT i.id, f.slug AS from_agent, t.slug AS to_agent, i.intent, i.status,
            i.hop_count, i.escalation_reason, i.created_at, i.payload
       FROM inboxes i
       JOIN agents t ON t.id = i.to_agent_id
       LEFT JOIN agents f ON f.id = i.from_agent_id
      ORDER BY i.created_at DESC LIMIT 100`,
  );
  return c.json(rows);
});

/** Cost per brain per day, for the usage chart. */
app.get('/api/usage/timeline', async (c) => {
  const rows = await query(
    `SELECT to_char(date_trunc('day', u.recorded_at), 'MM-DD') AS day,
            b.slug AS brain,
            round(sum(u.cost_usd)::numeric, 4)       AS cost,
            sum(u.input_tokens + u.output_tokens)::bigint AS tokens
       FROM usage u JOIN brain_accounts b ON b.id = u.brain_account_id
      WHERE u.recorded_at > now() - interval '14 days'
      GROUP BY 1, 2 ORDER BY 1`,
  );
  return c.json(rows);
});

/**
 * Machine health over time, per process.
 *
 * The supervisor has been sampling memory every few minutes since the beginning
 * and nothing has ever read it back. It is the most operationally useful series
 * this system has: agents are CLI processes on a home PC, and the failure that
 * actually happens is the box running out of memory while nobody is watching —
 * which shows up here as free_mb falling and one process climbing, hours before
 * anything else notices.
 *
 * Bucketed rather than raw. At one sample every few minutes a day is hundreds of
 * points, which is more than a phone-width chart can draw and more than anyone
 * can read; ten-minute buckets keep the shape and lose nothing that matters.
 */
app.get('/api/system/memory', async (c) => {
  const hours = Math.min(Number(c.req.query('hours') ?? 24) || 24, 168);
  const rows = await query(
    `SELECT to_char(bucket, 'MM-DD HH24:MI') AS at,
            extract(epoch FROM bucket)::bigint AS ts,
            round(avg(free_mb))::int           AS free_mb,
            max(total_mb)::int                 AS total_mb,
            round(avg(claude_desktop_mb))::int AS claude_desktop_mb,
            round(avg(claude_code_mb))::int    AS claude_code_mb,
            round(avg(simba_mb))::int          AS simba_mb,
            round(avg(ollama_mb))::int         AS ollama_mb,
            round(avg(postgres_mb))::int       AS postgres_mb,
            round(avg(process_count))::int     AS process_count
       FROM (
         SELECT to_timestamp(floor(extract(epoch FROM ts) / 600) * 600) AS bucket, *
           FROM system_samples
          WHERE ts > now() - make_interval(hours => $1)
       ) s
      GROUP BY bucket
      ORDER BY bucket`,
    [hours],
  );
  return c.json(rows);
});

/** Session lineage: the chain of continuations a piece of work has been through. */
app.get('/api/sessions/:id/lineage', async (c) => {
  const rows = await query(
    `WITH RECURSIVE chain AS (
       SELECT s.*, 0 AS depth FROM sessions s WHERE s.id = $1
       UNION ALL
       SELECT s2.*, chain.depth + 1
         FROM sessions s2 JOIN chain ON s2.id = chain.hydrated_from_session_id
        WHERE chain.depth < 20
     )
     SELECT left(chain.id::text, 8) AS id, chain.status, chain.cli, chain.depth,
            chain.swap_count, chain.created_at, b.slug AS brain
       FROM chain LEFT JOIN brain_accounts b ON b.id = chain.brain_account_id
      ORDER BY chain.depth`,
    [c.req.param('id')],
  );
  return c.json(rows);
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Create a Tier-1 agent from the UI. The roster is data; this is an INSERT. */
app.post('/api/agents', async (c) => {
  const b = await c.req.json<{
    slug: string; name: string; tier?: number; domain?: string;
    description?: string; modelTier?: string; cli?: string;
  }>();
  if (!b.slug || !b.name) return c.json({ error: 'slug and name required' }, 400);
  try {
    const row = await one<{ id: string }>(
      `INSERT INTO agents (slug, name, tier, domain, description, model_tier,
                           preferred_cli, permission_profile_id, node_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,
               (SELECT id FROM permission_profiles WHERE slug = 'default'),
               (SELECT id FROM nodes WHERE is_primary LIMIT 1))
       RETURNING id`,
      [b.slug, b.name, b.tier ?? 1, b.domain ?? null, b.description ?? null,
       b.modelTier ?? 'mid', b.cli ?? 'claude'],
    );
    return c.json({ id: row?.id });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

app.post('/api/agents/:slug/start', async (c) => {
  const body = await c.req.json<{
    prompt?: string;
    cwd?: string;
    modelTier?: 'high' | 'mid' | 'cheap' | 'free';
    brain?: string;
  }>();

  const slug = c.req.param('slug');
  const surface = surfaceOf(c);

  // Authority is the intersection of the agent's profile and the surface's
  // policy, so the surface check happens before anything is spawned.
  if (!surface) return c.json({ error: 'unknown origin surface' }, 403);
  const reach = await canReachAgent(surface, slug);
  if (!reach.allowed) {
    await logDenial(surface, `start ${slug}`, reach.reason ?? '');
    return c.json({ error: reach.reason }, 403);
  }

  const requested = body.modelTier ?? 'mid';
  const tier = clampModelTier(surface, requested);

  const result = await manager.start({
    agent: slug,
    prompt: body.prompt,
    cwd: body.cwd,
    modelTier: body.modelTier ? tier : undefined,
    brain: body.brain,
    surfaceId: surface.id,
  });

  if ('sessionId' in result && tier !== requested) {
    // Surfaced rather than silently applied: a downgrade changes the quality of
    // the work and the user should not have to infer it from the output.
    return c.json({ ...result, note: `model tier clamped to "${tier}" by ${surface.slug}` });
  }
  return c.json(result, 'error' in result ? 409 : 200);
});

/**
 * Refuse to let a lower-trust surface drive a higher-trust session.
 *
 * Found by an external audit, and it is the hole the whole surface split exists
 * to prevent. Authentication chose a surface correctly and then nothing checked
 * it again: any authenticated caller could list sessions, pick one started from
 * the desktop, and post instructions into it. Those instructions ran with the
 * *session's* authority, because MCP action checks read the session's stored
 * origin surface rather than the caller's. A phone service token could therefore
 * execute desktop-authority work by borrowing an existing session.
 *
 * Trust level is the comparison because that is what the split is expressed in:
 * desktop 100, macbook 70, phone 60, automation 20. Equal trust is fine — two
 * phone clients are the same principal. Reaching upward is not.
 */
async function mayDriveSession(
  callerSurface: Surface,
  sessionId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await one<{ origin: string | null; trust: number | null }>(
    `SELECT sf.slug AS origin, sf.trust_level AS trust
       FROM sessions s LEFT JOIN surfaces sf ON sf.id = s.origin_surface_id
      WHERE s.id = $1`,
    [sessionId],
  );
  if (!row) return { ok: false, reason: 'no such session' };

  // A session with no recorded origin predates surface tracking. Treat it as
  // desktop-authority rather than unrestricted: unknown provenance is the case
  // where guessing generously is worst.
  const sessionTrust = row.trust ?? 100;
  if (callerSurface.trust_level >= sessionTrust) return { ok: true };

  return {
    ok: false,
    reason:
      `surface "${callerSurface.slug}" (trust ${callerSurface.trust_level}) cannot drive a ` +
      `session originating from "${row.origin ?? 'unknown'}" (trust ${sessionTrust})`,
  };
}

app.post('/api/sessions/:id/send', async (c) => {
  const body = await c.req.json<{ text: string }>();
  const allowed = await mayDriveSession(surfaceOf(c), c.req.param('id'));
  if (!allowed.ok) {
    await logDenial(surfaceOf(c), 'session.send', allowed.reason);
    return c.json({ error: allowed.reason }, 403);
  }
  try {
    // Hand back the session the message actually reached. A revival or failover
    // creates a new id, and answering a bare {ok:true} left the client watching
    // a session that would never speak again.
    const { sessionId } = await manager.send(c.req.param('id'), body.text);
    return c.json({ ok: true, sessionId, movedTo: sessionId !== c.req.param('id') ? sessionId : null });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

app.post('/api/sessions/:id/kill', async (c) => {
  // Same rule as send: stopping someone else's higher-trust work is a lesser
  // harm than driving it, but it is still acting on authority you do not have.
  const allowed = await mayDriveSession(surfaceOf(c), c.req.param('id'));
  if (!allowed.ok) {
    await logDenial(surfaceOf(c), 'session.kill', allowed.reason);
    return c.json({ error: allowed.reason }, 403);
  }
  await manager.kill(c.req.param('id'));
  return c.json({ ok: true });
});

app.post('/api/agents/:slug/model', async (c) => {
  const body = await c.req.json<{ modelTier: 'high' | 'mid' | 'cheap' }>();
  const row = await one<{ slug: string }>(
    `UPDATE agents SET model_tier = $2, updated_at = now() WHERE slug = $1 RETURNING slug`,
    [c.req.param('slug'), body.modelTier],
  );
  // Mistyping a slug used to answer {ok:true}, so the app showed the new tier
  // against an agent whose tier had not moved — and the next session ran on the
  // old one with nothing to explain why.
  if (!row) return c.json({ error: 'no such agent' }, 404);
  return c.json({ ok: true });
});

/**
 * Force a brain swap. Exposed because it is genuinely useful — moving a session
 * off an account you want to preserve headroom on — and because it is the only
 * way to exercise the failover path without waiting to actually hit a limit.
 */
app.post('/api/sessions/:id/failover', async (c) => {
  const live = manager.getLive(c.req.param('id'));
  if (!live) return c.json({ error: 'session is not live' }, 409);
  await manager.failover(live, 'manual');
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Universal intake. The Android share sheet posts here, and so will Instagram
 * intake and webhooks. Deliberately does no work synchronously — capture must
 * feel instant from the phone, and triage happens on the supervisor's schedule.
 */
app.post('/api/capture', async (c) => {
  const b = await c.req.json<{ content: string; source?: string; url?: string; note?: string }>();
  if (!b.content?.trim()) return c.json({ error: 'content required' }, 400);

  // A URL is the single most useful thing to have extracted up front, since it
  // decides most of the routing.
  const url = b.url ?? b.content.match(/https?:\/\/[^\s<>"')]+/)?.[0] ?? null;

  // Stamped `automation` regardless of who posted it.
  //
  // Authority must follow the content's provenance, not the transport's. This
  // body came from a share sheet, a webhook or a reel — it is attacker-
  // influenceable text that an agent will later read and act on. Inheriting the
  // phone's authority because the phone happened to deliver it is precisely how
  // prompt injection turns into privilege. The `automation` surface exists for
  // this and was previously unused.
  const intake = await getSurface('automation');

  const row = await one<{ id: string }>(
    `INSERT INTO captures (source, content, url, note, origin_surface_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [b.source ?? 'unknown', b.content, url, b.note ?? null, intake?.id ?? null],
  );

  await recordEvent({
    type: 'capture.received',
    message: `captured from ${b.source ?? 'unknown'}${url ? `: ${url}` : ''}`,
    data: { captureId: row?.id, hasUrl: Boolean(url) },
  });

  return c.json({ id: row?.id, status: 'pending' });
});

app.get('/api/captures', async (c) => {
  const rows = await query(
    `SELECT c.id, c.source, left(c.content, 400) AS content, c.url, c.kind, c.title,
            c.summary, c.tags, c.status, c.note, c.created_at, a.slug AS routed_to
       FROM captures c
       LEFT JOIN agents a ON a.id = c.routed_agent_id
      ORDER BY c.created_at DESC LIMIT 100`,
  );
  return c.json(rows);
});

app.post('/api/captures/:id/:action', async (c) => {
  const action = c.req.param('action');
  const map: Record<string, string> = { reject: 'rejected', done: 'done', requeue: 'pending' };
  const status = map[action];
  if (!status) return c.json({ error: `unknown action: ${action}` }, 400);
  // RETURNING, and checked. Without it this reported {ok:true} for an id that
  // matched nothing — so a resolve against a capture that had been deleted, or
  // against a mistyped id, was indistinguishable from one that worked, and the
  // caller removed the row from view on the strength of it. The requests route
  // next door already answered 404 for exactly this; the two disagreeing is
  // worse than either, because it makes the correct one look like the anomaly.
  const row = await one<{ id: string }>(
    `UPDATE captures SET status = $2, resolved_at = CASE WHEN $2 IN ('rejected','done')
       THEN now() ELSE NULL END WHERE id = $1 RETURNING id`,
    [c.req.param('id'), status],
  );
  if (!row) return c.json({ error: 'no such capture' }, 404);
  return c.json({ ok: true, status });
});

/**
 * One box that finds anything operational.
 *
 * atlas — the control centre the operator built before Simba — had a command palette,
 * and it is the piece of that brief Simba was furthest from. There were two
 * searches here and they could not see each other: semantic recall over the
 * personal corpus, and trigram matching over requests, reachable only by curl.
 * Projects, sessions, missions and captures had none at all. So "that thing
 * about the forecasting model" had four possible homes and no way to ask.
 *
 * Knowledge is deliberately not included. That search embeds the query before
 * it can run, which is the right cost for "ask my own history a question" and
 * the wrong one for a box that should answer while you are still typing. It
 * keeps its own screen; this one stays SQL and stays instant.
 *
 * Everything here matches on words a person would actually remember — the
 * verbatim ask, the title, the file path — and never on an id.
 */
app.get('/api/find', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 2) return c.json([]);

  // UNION ALL rather than several round trips: the phone is on a tunnel, and
  // five sequential queries is five times the latency for one keystroke.
  //
  // `open` orders before `score` on purpose. Something still outstanding is
  // almost always what is being looked for, even when a finished thing matches
  // the words better — the question is nearly always "what happened to X".
  const rows = await query(
    `WITH hits AS (
       SELECT 'request' AS kind, r.id::text, r.ask AS title,
              coalesce(r.outcome, r.source) AS subtitle, r.status,
              r.created_at AS when_at,
              (r.status = 'open') AS live,
              similarity(r.ask, $1) AS score
         FROM requests r
        WHERE r.ask ILIKE '%' || $1 || '%' OR similarity(r.ask, $1) > 0.15

       UNION ALL
       SELECT 'capture', c.id::text, coalesce(c.title, left(c.content, 120)),
              coalesce(c.summary, c.url, c.source), c.status, c.created_at,
              (c.status = 'pending'),
              greatest(similarity(coalesce(c.title, ''), $1), similarity(left(c.content, 200), $1))
         FROM captures c
        WHERE c.content ILIKE '%' || $1 || '%' OR c.title ILIKE '%' || $1 || '%'
           OR c.url ILIKE '%' || $1 || '%'

       UNION ALL
       SELECT 'project', p.id::text, p.name, p.root_path, p.kind, p.last_commit_at,
              (p.dirty_files > 0 OR p.unpushed > 0),
              greatest(similarity(p.name, $1), similarity(coalesce(p.root_path, ''), $1))
         FROM projects p
        WHERE NOT p.archived
          AND (p.name ILIKE '%' || $1 || '%' OR p.root_path ILIKE '%' || $1 || '%'
               OR p.slug ILIKE '%' || $1 || '%')

       UNION ALL
       SELECT 'session', s.id::text, coalesce(s.title, '(untitled session)'),
              a.slug, s.status, s.started_at,
              (s.status IN ('running', 'idle')),
              similarity(coalesce(s.title, ''), $1)
         FROM sessions s JOIN agents a ON a.id = s.agent_id
        WHERE s.title ILIKE '%' || $1 || '%'

       UNION ALL
       SELECT 'mission', m.id::text, m.title, coalesce(m.objective, m.slug), m.status,
              m.created_at,
              (m.status IN ('running', 'blocked', 'pending')),
              greatest(similarity(m.title, $1), similarity(coalesce(m.objective, ''), $1))
         FROM missions m
        WHERE m.title ILIKE '%' || $1 || '%' OR m.objective ILIKE '%' || $1 || '%'
     )
     SELECT * FROM hits
      ORDER BY live DESC, score DESC NULLS LAST, when_at DESC NULLS LAST
      LIMIT 40`,
    [q],
  );
  return c.json(rows);
});

// ---------------------------------------------------------------------------
// Voice — the piece the vision names as missing
//
// "Speak a command, it routes to the right capability, the answer comes back
// aloud", and from the phone rather than only a desktop key. See the
// simba-vision document. Everything under here is local: faster-whisper for
// hearing, Windows SAPI for speaking, audio never leaving the machine.
// ---------------------------------------------------------------------------

app.get('/api/voice', async (c) => {
  // So a client can tell "voice is off" from "voice failed" from "voice is
  // warming up" — three states that feel identical from the outside and need
  // completely different words.
  return c.json({ ...voiceAvailable(), worker: await workerStatus() });
});

/** Audio in, transcript out. Separate from /ask so the phone can show what it heard. */
app.post('/api/voice/hear', async (c) => {
  const audio = Buffer.from(await c.req.arrayBuffer());
  if (audio.length === 0) return c.json({ error: 'no audio' }, 400);
  try {
    return c.json(await transcribe(audio, c.req.query('ext') ?? 'm4a'));
  } catch (err) {
    return c.json({ error: `could not transcribe: ${err}` }, 500);
  }
});

/** Text in, wav out. */
app.post('/api/voice/speak', async (c) => {
  const b = await c.req.json<{ text?: string }>();
  if (!b.text?.trim()) return c.json({ error: 'text required' }, 400);
  try {
    const wav = await speak(b.text);
    return new Response(new Uint8Array(wav), {
      headers: { 'content-type': 'audio/wav', 'content-length': String(wav.length) },
    });
  } catch (err) {
    return c.json({ error: `could not speak: ${err}` }, 500);
  }
});

/**
 * The whole loop: hear it, work out what it was, answer it.
 *
 * Answers the cheap intents from Postgres directly. Asking "what needs me"
 * should not cost a model call and thirty seconds to read back a number the
 * database already holds — and a voice assistant that takes half a minute to
 * say "nothing" is one you stop talking to.
 */
app.post('/api/voice/ask', async (c) => {
  const audio = Buffer.from(await c.req.arrayBuffer());
  if (audio.length === 0) return c.json({ error: 'no audio' }, 400);

  let heard;
  try {
    heard = await transcribe(audio, c.req.query('ext') ?? 'm4a');
  } catch (err) {
    return c.json({ error: `could not transcribe: ${err}` }, 500);
  }
  if (!heard.text.trim()) {
    return c.json({ heard: '', reply: "I didn't catch that.", intent: 'silence' });
  }

  const intent = classify(heard.text);
  let reply: string;

  switch (intent.kind) {
    case 'status': {
      const [stats] = await query<{ active: number; brains: number; spend: number }>(
        `SELECT (SELECT count(*)::int FROM sessions WHERE status IN ('running','idle')) AS active,
                (SELECT count(*)::int FROM brain_accounts WHERE enabled AND status = 'available') AS brains,
                (SELECT coalesce(sum(total_cost_usd),0) FROM sessions) AS spend`,
      );
      reply = `${stats?.active ?? 0} sessions running, ${stats?.brains ?? 0} brains available, ` +
              `$${Number(stats?.spend ?? 0).toFixed(2)} spent in total.`;
      break;
    }
    case 'needs_me': {
      const [n] = await query<{ actions: number; blocked: number; asks: number }>(
        `SELECT (SELECT count(*)::int FROM actions WHERE status = 'needs_confirmation') AS actions,
                (SELECT count(*)::int FROM missions WHERE status = 'blocked') AS blocked,
                (SELECT count(*)::int FROM requests WHERE status = 'open') AS asks`,
      );
      const bits: string[] = [];
      if (n?.actions) bits.push(`${n.actions} approval${n.actions > 1 ? 's' : ''} waiting`);
      if (n?.blocked) bits.push(`${n.blocked} mission${n.blocked > 1 ? 's' : ''} blocked`);
      if (n?.asks) bits.push(`${n.asks} thing${n.asks > 1 ? 's' : ''} you asked for still open`);
      reply = bits.length ? bits.join(', ') + '.' : 'Nothing needs you.';
      break;
    }
    case 'capture': {
      const row = await one<{ id: string }>(
        `INSERT INTO captures (source, content, origin_surface_id)
         VALUES ('voice', $1, (SELECT id FROM surfaces WHERE slug = 'automation')) RETURNING id`,
        [intent.text],
      );
      await recordEvent({ type: 'capture.received', message: `captured by voice: ${intent.text.slice(0, 90)}`,
                          data: { captureId: row?.id } });
      reply = 'Noted.';
      break;
    }
    default: {
      // Anything genuinely open-ended goes to the agent, and the caller decides
      // whether to wait — a real answer can take minutes, which is a bad thing
      // to hold a phone's microphone open for.
      reply = intent.text;
      return c.json({ heard: heard.text, intent: 'ask', reply: null,
                      forward: { agent: 'simba', prompt: intent.text } });
    }
  }

  return c.json({ heard: heard.text, intent: intent.kind, reply });
});

// ---------------------------------------------------------------------------
// Files — reading the PC from the phone
//
// The most dangerous surface here: file contents, over a tunnel, to a phone.
// See src/inventory/files.ts for why confinement is by resolved path and why
// secrets are masked by content rather than refused by filename. Read only —
// no write, no delete, no rename.
// ---------------------------------------------------------------------------

app.get('/api/files', async (c) => {
  const roots = await allowedRoots();
  const requested = c.req.query('path');

  // No path means "where can I start" rather than an error, so the client never
  // has to know a filesystem layout in order to ask its first question.
  if (!requested) {
    return c.json({
      roots,
      entries: roots.map((r) => ({
        name: r.split(/[\\/]/).filter(Boolean).pop() ?? r,
        path: r, kind: 'dir' as const, bytes: 0, modified: null,
      })),
    });
  }

  const dir = await confine(requested, roots);
  if (!dir) return c.json({ error: 'outside the readable roots' }, 403);
  try {
    return c.json({ roots, path: dir, entries: await listDir(dir) });
  } catch (err) {
    return c.json({ error: `cannot list: ${err}` }, 400);
  }
});

app.get('/api/files/read', async (c) => {
  const requested = c.req.query('path');
  if (!requested) return c.json({ error: 'path required' }, 400);

  const path = await confine(requested, await allowedRoots());
  if (!path) return c.json({ error: 'outside the readable roots' }, 403);
  try {
    return c.json(await readTextFile(path));
  } catch (err) {
    return c.json({ error: `cannot read: ${err}` }, 400);
  }
});

// ---------------------------------------------------------------------------
// Projects — what exists on this machine, ordered by what is at risk
// ---------------------------------------------------------------------------

app.get('/api/projects', async (c) => {
  // Ordered by exposure, not by name. A list of forty repositories alphabetised
  // is a list nobody opens twice; the same list with the three holding
  // unpublished work at the top is worth checking.
  const rows = await query(
    `SELECT p.id, p.slug, p.name, p.kind, p.root_path, p.git_remote, p.branch,
            p.dirty_files, p.unpushed, p.last_commit_at, p.last_scanned_at,
            p.scan_error, p.archived,
            (p.dirty_files > 0 OR p.unpushed > 0) AS at_risk,
            a.slug AS owner
       FROM projects p
       LEFT JOIN agents a ON a.project_id = p.id
      WHERE NOT p.archived
      ORDER BY (p.dirty_files + p.unpushed) DESC, p.last_commit_at DESC NULLS LAST
      LIMIT 200`,
  );
  return c.json(rows);
});

/**
 * Rescan now.
 *
 * A POST because it walks the disk and runs git in every repository it finds —
 * cheap enough to ask for, too expensive to do on every page load.
 */
app.post('/api/projects/scan', async (c) => {
  const result = await scanProjects();
  await recordEvent({
    type: 'projects.scanned',
    message: `${result.scanned} projects, ${result.atRisk} holding unpublished work`,
    data: result,
  });
  return c.json(result);
});

// ---------------------------------------------------------------------------
// Requests — things the operator asked for, kept until they are answered
//
// The gap these close: he attached "can you download and setup the project that
// lets wifi thru walls work" to a reel, and days later asked an agent to check
// progress on it. The agent searched everywhere it knew and reported that no
// such project existed in his tracked work. The ask had been stored as a string
// in a meta.json next to a video — a property of the reel rather than a thing
// he was owed — so nothing could find it and nothing was keeping it open.
// ---------------------------------------------------------------------------

app.get('/api/requests', async (c) => {
  // Open first and oldest first within that: a three-week-old ask is the one
  // worth surfacing, and burying it under this morning's is how it stays lost.
  const rows = await query(
    `SELECT r.id, r.ask, r.source, r.status, r.outcome, r.created_at, r.closed_at,
            r.capture_id, c.url AS capture_url, a.slug AS agent
       FROM requests r
       LEFT JOIN captures c ON c.id = r.capture_id
       LEFT JOIN sessions s ON s.id = r.session_id
       LEFT JOIN agents a ON a.id = s.agent_id
      ORDER BY (r.status = 'open') DESC,
               CASE WHEN r.status = 'open' THEN r.created_at END ASC,
               r.closed_at DESC NULLS LAST
      LIMIT 100`,
  );
  return c.json(rows);
});

/**
 * "that thing I asked you about" — find it by any word he remembers.
 *
 * Trigram similarity rather than exact matching, because he will not reproduce
 * his own phrasing: the ask said "wifi thru walls", the follow-up said "wifi
 * thru walls project", and a system that needs those to match exactly is a
 * system that answers "I can't find it" to a question it has the answer to.
 */
app.get('/api/requests/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (!q) return c.json([]);
  const rows = await query(
    `SELECT id, ask, source, status, outcome, created_at, closed_at,
            similarity(ask, $1) AS score
       FROM requests
      WHERE ask ILIKE '%' || $1 || '%' OR similarity(ask, $1) > 0.15
      ORDER BY (status = 'open') DESC, score DESC
      LIMIT 20`,
    [q],
  );
  return c.json(rows);
});

app.post('/api/requests', async (c) => {
  const b = await c.req.json<{
    ask: string; source?: string; captureId?: string | null;
  }>();
  if (!b.ask?.trim()) return c.json({ error: 'ask required' }, 400);

  const row = await one<{ id: string }>(
    `INSERT INTO requests (ask, source, capture_id) VALUES ($1, $2, $3) RETURNING id`,
    [b.ask.trim(), b.source ?? 'unknown', b.captureId ?? null],
  );
  await recordEvent({
    type: 'request.opened',
    message: `asked: ${b.ask.trim().slice(0, 120)}`,
    data: { requestId: row?.id, source: b.source ?? 'unknown' },
  });
  return c.json({ id: row?.id, status: 'open' });
});

app.post('/api/requests/:id/:action', async (c) => {
  const action = c.req.param('action');
  const map: Record<string, string> = { done: 'done', drop: 'dropped', reopen: 'open' };
  const status = map[action];
  if (!status) return c.json({ error: `unknown action: ${action}` }, 400);

  const body = await c.req.json<{ outcome?: string }>().catch(() => ({ outcome: undefined }));
  const row = await one<{ ask: string }>(
    `UPDATE requests
        SET status = $2,
            outcome = COALESCE($3, outcome),
            closed_at = CASE WHEN $2 = 'open' THEN NULL ELSE now() END
      WHERE id = $1 RETURNING ask`,
    [c.req.param('id'), status, body.outcome ?? null],
  );
  if (!row) return c.json({ error: 'no such request' }, 404);
  await recordEvent({
    type: `request.${status}`,
    message: `${status}: ${row.ask.slice(0, 120)}`,
    data: { requestId: c.req.param('id') },
  });
  return c.json({ ok: true, status });
});

// ---------------------------------------------------------------------------
// Reels
//
// ReelAgent is a separate process with its own pipeline — Instagram DMs in,
// yt-dlp and Whisper and a headless Claude pass, a writeup out. It already
// records every arrival in `captures`, which is what puts reels on the Now
// screen. What it cannot do is reach the phone: it listens on loopback, and the
// phone talks to this gateway through the tunnel.
//
// So these proxy rather than reimplement. Anything ReelAgent knows about its own
// items stays ReelAgent's business; this just carries it across the boundary
// that Cloudflare Access is guarding, so the app needs exactly one credential.
// ---------------------------------------------------------------------------

async function reelFetch(path: string, init?: RequestInit) {
  return fetch(`${config.reels.url}${path}`, {
    ...init,
    signal: AbortSignal.timeout(config.reels.timeoutMs),
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${config.reels.token}` },
  });
}

async function capturesAsReels() {
  const rows = await query<{
    id: string;
    title: string | null;
    summary: string | null;
    url: string | null;
    content: string | null;
    status: string;
    created_at: Date;
  }>(
    `SELECT id::text, title, summary, url, left(content, 280) AS content, status, created_at
       FROM captures
      WHERE url IS NOT NULL OR kind IN ('reel', 'instagram', 'share')
      ORDER BY created_at DESC
      LIMIT 80`,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title || (r.content ? r.content.slice(0, 80) : 'Untitled reel'),
    received: r.created_at.toISOString(),
    done: r.status !== 'pending',
    summary: r.summary || r.content,
    has_notes: Boolean(r.summary),
    has_media: false,
    frames: 0,
    source_url: r.url,
  }));
}

app.get('/api/reels', async (c) => {
  try {
    const [items, health] = await Promise.all([
      reelFetch('/items').then((r) => r.json() as Promise<{ items: unknown[] }>),
      reelFetch('/health').then((r) => r.json() as Promise<Record<string, unknown>>),
    ]);
    return c.json({ items: items.items ?? [], health, reachable: true });
  } catch (err) {
    // A dead ReelAgent is a normal state to render, not an error to throw at
    // the phone — the app shows "not running" and offers to say why.
    //
    // The list still has somewhere to come from: captures. ReelAgent writes
    // every arrival there, so an empty items array while the pipeline is off
    // was lying — it looked like nothing had ever been shared.
    return c.json({
      items: await capturesAsReels(),
      reachable: false,
      error: String(err),
    });
  }
});

app.get('/api/reels/:id', async (c) => {
  try {
    const r = await reelFetch(`/items/${encodeURIComponent(c.req.param('id'))}`);
    if (!r.ok) return c.json({ error: 'no such reel' }, 404);
    return c.json(await r.json());
  } catch (err) {
    return c.json({ error: String(err) }, 502);
  }
});

/** Push a link into the reel pipeline from the app's share sheet. */
app.post('/api/reels', async (c) => {
  const b = await c.req.json<{ url?: string; note?: string }>();
  if (!b.url?.trim() && !b.note?.trim()) return c.json({ error: 'url or note required' }, 400);
  try {
    const r = await reelFetch('/intake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: b.url, note: b.note, source: 'simba' }),
    });
    const body = await r.json();
    if (!r.ok) return c.json(body, r.status as 400);
    await recordEvent({
      type: 'capture.received',
      message: `reel queued from the app${b.url ? `: ${b.url}` : ''}`,
      data: { url: b.url ?? null },
    });
    return c.json(body, 202);
  } catch (err) {
    return c.json({ error: `reel agent unreachable: ${err}` }, 502);
  }
});

// ---------------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------------

app.get('/api/missions', async (c) => {
  const rows = await query(`SELECT * FROM mission_progress ORDER BY updated_at DESC LIMIT 60`);
  return c.json(rows);
});

app.get('/api/missions/:id', async (c) => {
  const id = c.req.param('id');
  const [mission, steps, log] = await Promise.all([
    one(`SELECT m.*, a.slug AS agent FROM missions m
           LEFT JOIN agents a ON a.id = m.owner_agent_id WHERE m.id = $1`, [id]),
    query(`SELECT seq, title, instruction, kind, status, attempts, depends_on,
                  left(coalesce(result,''),600) AS result,
                  left(coalesce(failures,''),600) AS failures,
                  session_id, started_at, completed_at
             FROM mission_steps WHERE mission_id = $1 ORDER BY seq`, [id]),
    query(`SELECT ts, level, message FROM mission_log
            WHERE mission_id = $1 ORDER BY ts DESC LIMIT 120`, [id]),
  ]);
  return mission ? c.json({ mission, steps, log }) : c.json({ error: 'not found' }, 404);
});

/**
 * Create a mission. This is the entry point for "go do this and don't come back
 * until it's done" — the objective is stored verbatim and decomposed by a
 * planning session on the next supervisor tick.
 */
app.post('/api/missions', async (c) => {
  const b = await c.req.json<{
    title: string; objective: string; acceptanceCriteria?: string;
    agent?: string; workingDir?: string; maxSessions?: number; maxCostUsd?: number;
    cadence?: 'continuous' | 'scheduled'; cron?: string;
    /** Plain English: "every morning", "weekdays at 9", "every 30 minutes". */
    schedule?: string;
    /** A command to run instead of an agent. No model is involved at all. */
    script?: string;
    scriptShell?: 'powershell' | 'bash' | 'cmd';
  }>();

  // Accept a schedule in English. Cron is precise and nobody states a recurring
  // objective that way, so requiring it is what stops the feature being used at
  // all. A phrase that cannot be parsed is refused rather than defaulted:
  // running something at an hour nobody chose is worse than not scheduling it.
  let cron = b.cron ?? null;
  let cadence: string | null = b.cadence ?? null;
  let scheduleNote: string | null = null;
  if (b.schedule) {
    const parsed = parseSchedule(b.schedule);
    if (!parsed) {
      return c.json(
        {
          error: `could not understand the schedule "${b.schedule}"`,
          examples: ['every morning', 'weekdays at 9', 'every 30 minutes', 'every friday at 18:00'],
        },
        400,
      );
    }
    cron = parsed.cron;
    cadence = 'scheduled';
    scheduleNote = parsed.describes;
  }
  if (!b.title || !b.objective) return c.json({ error: 'title and objective required' }, 400);

  const surface = surfaceOf(c);
  if (!surface) return c.json({ error: 'unknown origin surface' }, 403);

  /**
   * Reject an unknown owner instead of quietly promoting the mission.
   *
   * The insert resolved the agent with a nullable subquery, so a typo stored
   * owner_agent_id = NULL — and both the planner and the executor default null
   * ownership to the tier-0 `simba` agent. Asking for "windows-admn" therefore
   * ran the whole mission as Simba, on the strongest model and with the widest
   * authority, silently. A misspelling should not be a privilege escalation.
   */
  if (b.agent) {
    const owner = await one<{ id: string }>(
      `SELECT id FROM agents WHERE slug = $1 AND retired_at IS NULL`,
      [b.agent],
    );
    if (!owner) {
      const known = await query<{ slug: string }>(
        `SELECT slug FROM agents WHERE retired_at IS NULL ORDER BY tier, slug`,
      );
      return c.json(
        {
          error: `unknown agent "${b.agent}"`,
          known: known.map((a) => a.slug),
        },
        400,
      );
    }
  }

  const row = await one<{ id: string }>(
    `INSERT INTO missions (title, objective, acceptance_criteria, owner_agent_id,
                           working_dir, max_sessions, max_cost_usd, cadence, cron,
                           origin_surface_id, status, schedule_note)
     VALUES ($1,$2,$3,
             (SELECT id FROM agents WHERE slug = coalesce($4,'simba') AND retired_at IS NULL),
             $5, coalesce($6,40), coalesce($7,25.0), coalesce($8,'continuous'), $9, $10, 'planning', $11)
     RETURNING id`,
    [b.title, b.objective, b.acceptanceCriteria ?? null, b.agent ?? null,
     b.workingDir ?? null, b.maxSessions ?? null, b.maxCostUsd ?? null,
     cadence, cron, surface.id, scheduleNote],
  );

  // A script mission never plans and never starts a session.
  if (b.script) {
    await query(
      `UPDATE missions SET script = $2, script_shell = $3, status = 'running' WHERE id = $1`,
      [row?.id, b.script, b.scriptShell ?? 'powershell'],
    );
  }

  await query(`INSERT INTO mission_log (mission_id, message) VALUES ($1,$2)`,
    [row?.id, `mission created from ${surface.slug}${scheduleNote ? ` - runs ${scheduleNote}` : ''}`]);

  return c.json({
    id: row?.id,
    status: b.script ? 'running' : 'planning',
    // Read the schedule back so a misparse is visible now rather than after a
    // month of firing at the wrong hour.
    ...(scheduleNote ? { schedule: scheduleNote, cron } : {}),
    ...(b.script ? { mode: 'script - no model will be used' } : {}),
  });
});

app.post('/api/missions/:id/:action', async (c) => {
  const action = c.req.param('action');

  /**
   * Raise a ceiling and carry on.
   *
   * A mission that hits its session or cost budget stops with the reason
   * recorded, which is correct — that limit is the only thing standing between
   * an unattended objective and an unbounded one. But there was no way to lift
   * it except editing the database by hand, so from the phone a blocked mission
   * was simply dead. Observed for real: an eight-step mission was given a
   * six-session budget, blocked at step six exactly as designed, and needed a
   * manual UPDATE to finish.
   *
   * Raising only. Lowering a ceiling mid-flight would block the mission again
   * on the next tick, which is a confusing way to express "stop" when pause and
   * cancel already exist.
   */
  if (action === 'budget') {
    const b = await c.req.json<{ maxSessions?: number; maxCostUsd?: number }>();
    const row = await one<{ max_sessions: number; max_cost_usd: number; status: string }>(
      `UPDATE missions
          SET max_sessions = greatest(max_sessions, coalesce($2, max_sessions)),
              max_cost_usd = greatest(max_cost_usd, coalesce($3, max_cost_usd)),
              -- Clearing the block is the point: raising the ceiling and
              -- leaving it blocked would just require a second call.
              status = CASE WHEN status = 'blocked' THEN 'running' ELSE status END,
              blocked_reason = CASE WHEN status = 'blocked' THEN NULL ELSE blocked_reason END,
              consecutive_failures = 0,
              updated_at = now()
        WHERE id = $1
        RETURNING max_sessions, max_cost_usd, status`,
      [c.req.param('id'), b.maxSessions ?? null, b.maxCostUsd ?? null],
    );
    if (!row) return c.json({ error: 'no such mission' }, 404);
    await query(
      `INSERT INTO mission_log (mission_id, level, message) VALUES ($1,'info',$2)`,
      [c.req.param('id'), `budget raised to ${row.max_sessions} sessions / $${row.max_cost_usd}`],
    );
    return c.json({ ok: true, ...row });
  }

  const map: Record<string, string> = {
    pause: 'paused', resume: 'running', cancel: 'cancelled', retry: 'running',
  };
  const status = map[action];
  if (!status) return c.json({ error: `unknown action: ${action}` }, 400);

  // Retry clears the circuit breaker and requeues failed steps; without that a
  // retry on a blocked mission trips again on the next tick.
  if (action === 'retry') {
    await query(
      `UPDATE mission_steps SET status = 'pending', attempts = 0
        WHERE mission_id = $1 AND status = 'failed'`,
      [c.req.param('id')],
    );
  }
  await query(
    `UPDATE missions SET status = $2, consecutive_failures = 0,
                         blocked_reason = NULL, updated_at = now()
      WHERE id = $1`,
    [c.req.param('id'), status],
  );

  /**
   * Stopping a mission has to stop the work, not just relabel the row.
   *
   * Pause and cancel previously updated the mission and nothing else. The API
   * answered `cancelled` while the agent carried on editing files or completing
   * an external operation, and the executor only reaps sessions for steps
   * already marked succeeded, failed or skipped — a running step was never
   * touched. Press cancel while something is midway through a deployment and it
   * finishes the deployment.
   *
   * Killing the session leaves the step 'running' with a dead session, which
   * reopenOrphanedSteps would ordinarily requeue. Marking it skipped first is
   * what makes the stop stick; resuming re-plans from there rather than
   * resurrecting a half-finished attempt.
   */
  if (action === 'pause' || action === 'cancel') {
    // Checked before anything is killed. Without this, pausing a mission id
    // that does not exist reported {ok:true, stoppedSteps:0} — which reads
    // exactly like "paused a mission that happened to have no running steps",
    // the single most common real case, so the lie was invisible.
    const mission = await one<{ id: string }>(`SELECT id FROM missions WHERE id = $1`, [
      c.req.param('id'),
    ]);
    if (!mission) return c.json({ error: 'no such mission' }, 404);

    const live = await query<{ id: string; session_id: string; seq: number }>(
      `SELECT id, session_id, seq FROM mission_steps
        WHERE mission_id = $1 AND status = 'running' AND session_id IS NOT NULL`,
      [c.req.param('id')],
    );

    for (const step of live) {
      await query(`UPDATE mission_steps SET status = 'skipped' WHERE id = $1`, [step.id]);
      await manager.kill(step.session_id).catch(() => {
        /* already gone; the state change is what matters */
      });
      await query(
        `INSERT INTO mission_log (mission_id, level, message) VALUES ($1,'warn',$2)`,
        [c.req.param('id'), `step ${step.seq} stopped by ${action}`],
      );
    }

    if (live.length > 0) {
      await recordEvent({
        type: 'mission.stopped',
        severity: 'info',
        message: `${action}: killed ${live.length} running step session(s)`,
        data: { missionId: c.req.param('id'), action, steps: live.map((s) => s.seq) },
      });
    }
    return c.json({ ok: true, status, stoppedSteps: live.length });
  }

  return c.json({ ok: true, status });
});

app.get('/api/briefs', async (c) => {
  const rows = await query(
    `SELECT id, kind, headline, body, needs_decision, stuck, active_agents,
            active_missions, round(cost_since_last,4) AS cost, created_at, notified_at
       FROM briefs ORDER BY created_at DESC LIMIT 40`,
  );
  return c.json(rows);
});

/** Undelivered briefs, for a phone poller or push worker to drain. */
app.get('/api/briefs/pending', async (c) => {
  const rows = await query(
    `SELECT id, headline, body, needs_decision, stuck, created_at
       FROM briefs WHERE notified_at IS NULL ORDER BY created_at LIMIT 10`,
  );
  return c.json(rows);
});

app.post('/api/briefs/:id/ack', async (c) => {
  const row = await one<{ id: string }>(
    `UPDATE briefs SET notified_at = now() WHERE id = $1 RETURNING id`,
    [c.req.param('id')],
  );
  if (!row) return c.json({ error: 'no such brief' }, 404);
  return c.json({ ok: true });
});

app.get('/api/surfaces', async (c) => {
  const rows = await query(`SELECT * FROM surface_activity ORDER BY trust_level DESC`);
  return c.json(rows);
});

/** Actions held pending an explicit confirmation, plus anything stuck. */
app.get('/api/actions/pending', async (c) => {
  const rows = await query(`SELECT * FROM actions_needing_attention ORDER BY created_at DESC LIMIT 50`);
  return c.json(rows);
});

app.post('/api/actions/:id/confirm', async (c) => {
  // Desktop-only. At the previous threshold of 60 the phone could confirm its
  // own confirmations, which made the entire confirm_action_classes mechanism
  // decorative for the one surface it was written to constrain.
  const surface = surfaceOf(c);
  if (surface.trust_level < 100) {
    return c.json(
      { error: 'confirmations must be approved from the desktop, not the surface that raised them' },
      403,
    );
  }
  const body = await c.req.json<{ approve: boolean }>().catch(() => ({ approve: false }));
  const decided = await one<{ id: string }>(
    `UPDATE actions SET status = $2, lease_expires_at = NULL
      WHERE id = $1 AND status = 'needs_confirmation' RETURNING id`,
    [c.req.param('id'), body.approve ? 'claimed' : 'abandoned'],
  );

  // Answering {ok:true} when nothing was updated is the most expensive version
  // of this bug in the whole gateway. An approval is the one thing on the phone
  // that unblocks a stopped agent, and both the Now screen and the overlay drop
  // the row from view when the call succeeds — so a confirmation that never
  // landed would disappear from the only surface that was telling you an agent
  // was waiting, and the agent would sit blocked with nothing anywhere saying so.
  //
  // The two ways to update nothing need different words. There is no such
  // action, or there is one and it was already decided — the second is a race
  // between the phone and the desktop, or a double tap, and "already handled"
  // is a true and reassuring answer where "no such action" would look broken.
  if (!decided) {
    const existing = await one<{ status: string }>(
      `SELECT status FROM actions WHERE id = $1`,
      [c.req.param('id')],
    );
    if (!existing) return c.json({ error: 'no such action' }, 404);
    return c.json(
      { error: `already ${existing.status}`, status: existing.status, alreadyDecided: true },
      409,
    );
  }
  return c.json({ ok: true, approved: body.approve });
});

/** Panic button: stop the world. */
app.post('/api/panic', async (c) => {
  // Evaluated before any enabled/disabled check on purpose: disabling a lost
  // phone must not also remove the ability to panic-stop from it. Previously
  // this read `if (surface && ...)`, so a null surface skipped the check
  // entirely — the failure mode was "unknown caller can stop everything".
  const surface = surfaceOf(c);
  if (!surface.can_panic) {
    return c.json({ error: `${surface.slug} cannot trigger a panic stop` }, 403);
  }
  const killed = await manager.killAll();
  broadcast({ type: 'panic', killed });
  return c.json({ ok: true, killed });
});

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

/**
 * The web control center, local channel only.
 *
 * Not served over the tunnel: it would drag cookie-bearing browser context onto
 * a public hostname for no benefit, since the phone uses the native app. Keeping
 * the remote surface to JSON + WebSocket is a meaningfully smaller thing to
 * defend.
 */
app.get('/', async (c) => {
  if (c.get('channel') === 'tunnel') return c.notFound();
  const html = await readFile(join(config.root, 'app', 'index.html'), 'utf8');
  return c.html(html);
});

/**
 * Two listeners, both bound to loopback.
 *
 * Local (8787) is trusted; the tunnel listener (8788) is the only port
 * cloudflared may target and requires a verified Access identity. Splitting by
 * port is what makes the channel unforgeable — a client controls its headers,
 * but not which socket its connection lands on.
 */
/**
 * Refuse to run as a second copy.
 *
 * A gateway that cannot bind used to keep running: the HTTP server failed but
 * the process stayed alive because the supervisor's timers hold the event loop
 * open. That is the worst possible outcome — it serves nothing while looking
 * healthy in a process list, and worse, its supervisor keeps scheduling
 * alongside the real one. Two supervisors racing to start sessions is the same
 * class of fault as the runaway spawner, arriving by a different route.
 *
 * Exiting on a bind failure makes a duplicate impossible instead of merely
 * unlikely.
 */
function fatalOnBindFailure(server: { on(ev: 'error', cb: (e: NodeJS.ErrnoException) => void): void }, label: string): void {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[gateway] ${label} port is already in use — another Simba gateway is running. ` +
          `Refusing to start a second supervisor. Stop the other one first.`,
      );
    } else {
      console.error(`[gateway] ${label} failed to listen:`, err.message);
    }
    process.exit(1);
  });
}

const localServer = serve(
  { fetch: app.fetch, port: config.gateway.port, hostname: config.gateway.host },
  (info) => console.log(`[gateway] local  http://${config.gateway.host}:${info.port}`),
);
fatalOnBindFailure(localServer, 'local');

const tunnelServer = config.access.enabled
  ? serve(
      { fetch: app.fetch, port: config.gateway.tunnelPort, hostname: config.gateway.host },
      (info) => console.log(`[gateway] tunnel http://${config.gateway.host}:${info.port} (Access required)`),
    )
  : null;
if (tunnelServer) fatalOnBindFailure(tunnelServer, 'tunnel');

// noServer + a manual upgrade handler, rather than `verifyClient`.
//
// verifyClient is discouraged by ws and can only abort the socket — it cannot
// return a status, which makes a remote auth failure undebuggable. Handling the
// upgrade directly also lets the WebSocket reuse the exact same authenticate()
// as HTTP, so there is one decision table rather than two that drift.
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

const MAX_SOCKETS = 20;

function denyUpgrade(socket: NodeJS.WritableStream & { destroy: () => void }, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  } catch {
    /* peer already gone */
  }
  socket.destroy();
}

function attachUpgrade(server: unknown, channel: Channel): void {
  (server as { on: (e: string, cb: (...a: never[]) => void) => void }).on(
    'upgrade',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req: any, socket: any, head: any) => {
      // Attached before the await: a client that aborts mid-verification
      // otherwise raises an unhandled ECONNRESET and takes the gateway down.
      socket.on('error', () => {});

      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') return denyUpgrade(socket, 404, 'Not Found');

      const headers = req.headers as Record<string, string | undefined>;

      // Same-origin policy does not apply to WebSockets and `ws` does not check
      // Origin, so without this any page the user visits could open a socket to
      // the local gateway and read the entire live agent stream.
      if (!originAllowed(channel, headers.origin)) {
        return denyUpgrade(socket, 403, 'Forbidden');
      }
      if (sockets.size >= MAX_SOCKETS) return denyUpgrade(socket, 503, 'Too Many Connections');

      authenticate(channel, headers)
        .then((auth) => {
          if (!auth.ok) return denyUpgrade(socket, auth.status, 'Unauthorized');
          if (socket.destroyed || !socket.writable) return; // died during the await
          wss.handleUpgrade(req, socket, head, (ws) => {
            (ws as WebSocket & { surface?: Surface }).surface = auth.surface;
            wss.emit('connection', ws, req);
          });
        })
        .catch(() => denyUpgrade(socket, 500, 'Internal Server Error'));
    },
  );
}

attachUpgrade(localServer, 'local');
if (tunnelServer) attachUpgrade(tunnelServer, 'tunnel');

wss.on('connection', (ws) => {
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
  ws.on('pong', () => ((ws as WebSocket & { alive?: boolean }).alive = true));
  ws.send(JSON.stringify({ type: 'hello', at: new Date().toISOString() }));
});

// Dead-socket sweep. `sockets` was previously unbounded and never pruned except
// on a clean close, so a dropped phone connection leaked an entry indefinitely.
setInterval(() => {
  for (const ws of sockets) {
    const s = ws as WebSocket & { alive?: boolean };
    if (s.alive === false) {
      ws.terminate();
      sockets.delete(ws);
      continue;
    }
    s.alive = false;
    try {
      ws.ping();
    } catch {
      sockets.delete(ws);
    }
  }
}, 30_000).unref();

void prewarmAccess();

const orphaned = await manager.reconcileOnStartup();
if (orphaned > 0) console.log(`[gateway] reconciled ${orphaned} orphaned session(s)`);

supervisor.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[gateway] ${signal}, shutting down`);
    supervisor.stop();
    process.exit(0);
  });
}
