import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from '../config.js';
import { query, one } from '../db/index.js';
import { SessionManager } from '../session/manager.js';
import { Supervisor } from '../supervisor/index.js';
import { recall } from '../knowledge/embed.js';
import {
  resolveSurface,
  canReachAgent,
  clampModelTier,
  logDenial,
  type Surface,
} from '../policy/surface.js';

/** Resolves the surface behind a request. Loopback is the desktop; the tunnel is the phone. */
async function surfaceOf(c: {
  req: { header: (name?: string) => string | undefined | Record<string, string> };
  env?: unknown;
}): Promise<Surface | null> {
  const headers = (c.req.header() ?? {}) as Record<string, string | undefined>;
  const remote =
    (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket
      ?.remoteAddress ?? '127.0.0.1';
  return resolveSurface(headers, remote);
}

/**
 * The gateway: HTTP for state and commands, websockets for live output.
 *
 * Bound to loopback by design — reachability from the phone comes from a
 * Cloudflare Tunnel in front of this, never from opening a port.
 */

const manager = new SessionManager();
const supervisor = new Supervisor(manager);
const app = new Hono();

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

// Optional bearer token. Cloudflare Access is the real gate; this is a second
// lock for when the tunnel is up but Access is misconfigured.
app.use('/api/*', async (c, next) => {
  if (config.gateway.token) {
    const auth = c.req.header('authorization');
    if (auth !== `Bearer ${config.gateway.token}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
  }
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

app.get('/api/sessions', async (c) => {
  const rows = await query(
    `SELECT s.id, s.status, s.title, s.description, s.tags, s.cli, s.cwd,
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
  const hits = await recall(q, { limit: Number(c.req.query('limit') ?? 12) });
  return c.json(
    hits.map((h) => ({
      source: h.source,
      title: h.title,
      relevance: Number((1 - h.distance).toFixed(3)),
      content: h.content.slice(0, 1500),
    })),
  );
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
  const surface = await surfaceOf(c);

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

app.post('/api/sessions/:id/send', async (c) => {
  const body = await c.req.json<{ text: string }>();
  try {
    await manager.send(c.req.param('id'), body.text);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

app.post('/api/sessions/:id/kill', async (c) => {
  await manager.kill(c.req.param('id'));
  return c.json({ ok: true });
});

app.post('/api/agents/:slug/model', async (c) => {
  const body = await c.req.json<{ modelTier: 'high' | 'mid' | 'cheap' }>();
  await query(`UPDATE agents SET model_tier = $2, updated_at = now() WHERE slug = $1`, [
    c.req.param('slug'),
    body.modelTier,
  ]);
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
  const surface = await surfaceOf(c);
  // Confirming is itself an authority-bearing act. Only a surface that could
  // have originated the class in the first place may release it.
  if (!surface || surface.trust_level < 60) {
    return c.json({ error: 'this surface cannot confirm actions' }, 403);
  }
  const body = await c.req.json<{ approve: boolean }>().catch(() => ({ approve: false }));
  await query(
    `UPDATE actions SET status = $2, lease_expires_at = NULL WHERE id = $1 AND status = 'needs_confirmation'`,
    [c.req.param('id'), body.approve ? 'claimed' : 'abandoned'],
  );
  return c.json({ ok: true, approved: body.approve });
});

/** Panic button: stop the world. */
app.post('/api/panic', async (c) => {
  const surface = await surfaceOf(c);
  if (surface && !surface.can_panic) {
    return c.json({ error: `${surface.slug} cannot trigger a panic stop` }, 403);
  }
  const killed = await manager.killAll();
  broadcast({ type: 'panic', killed });
  return c.json({ ok: true, killed });
});

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

app.get('/', async (c) => {
  const html = await readFile(join(config.root, 'app', 'index.html'), 'utf8');
  return c.html(html);
});

const server = serve({ fetch: app.fetch, port: config.gateway.port, hostname: config.gateway.host }, (info) => {
  console.log(`[gateway] http://${config.gateway.host}:${info.port}`);
});

const wss = new WebSocketServer({ server: server as never, path: '/ws' });
wss.on('connection', (ws) => {
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
  ws.send(JSON.stringify({ type: 'hello', at: new Date().toISOString() }));
});

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
