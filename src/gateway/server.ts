import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from '../config.js';
import { query, one } from '../db/index.js';
import { SessionManager } from '../session/manager.js';
import { Supervisor } from '../supervisor/index.js';

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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

app.post('/api/agents/:slug/start', async (c) => {
  const body = await c.req.json<{
    prompt?: string;
    cwd?: string;
    modelTier?: 'high' | 'mid' | 'cheap';
    brain?: string;
  }>();
  const result = await manager.start({
    agent: c.req.param('slug'),
    prompt: body.prompt,
    cwd: body.cwd,
    modelTier: body.modelTier,
    brain: body.brain,
  });
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

/** Panic button: stop the world. */
app.post('/api/panic', async (c) => {
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
