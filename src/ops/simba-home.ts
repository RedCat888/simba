import { query, one } from '../db/index.js';
import type { SessionManager } from '../session/manager.js';

const HOME_AGENT = 'simba';

export type TodayItem = {
  kind: 'action' | 'mission' | 'capture' | 'request' | 'session' | 'event' | 'brief';
  id: string;
  title: string;
  detail: string | null;
  status: string | null;
  at: string | null;
  href?: string;
};

export type TodayPayload = {
  needsMe: TodayItem[];
  running: TodayItem[];
  overnight: TodayItem[];
  simba: { sessionId: string | null };
};

async function pin(agentSlug: string, sessionId: string): Promise<void> {
  await query(
    `INSERT INTO home_threads (agent_slug, session_id, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (agent_slug) DO UPDATE SET session_id = $2, updated_at = now()`,
    [agentSlug, sessionId],
  );
}

/**
 * The session every surface should talk to.
 *
 * Follows a superseded pin to its newest child so a revival does not fork
 * a second home thread. If nothing is pinned, adopts the latest non-superseded
 * Simba session rather than starting a silent empty one.
 */
export async function getHomeSessionId(agentSlug = HOME_AGENT): Promise<string | null> {
  const pinned = await one<{ session_id: string }>(
    `SELECT session_id FROM home_threads WHERE agent_slug = $1`,
    [agentSlug],
  );

  if (pinned?.session_id) {
    const row = await one<{ id: string; status: string }>(
      `SELECT id, status FROM sessions WHERE id = $1`,
      [pinned.session_id],
    );
    if (row && row.status !== 'superseded') return row.id;

    const child = await one<{ id: string }>(
      `SELECT id FROM sessions
        WHERE hydrated_from_session_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [pinned.session_id],
    );
    if (child) {
      await pin(agentSlug, child.id);
      return child.id;
    }
  }

  const latest = await one<{ id: string }>(
    `SELECT s.id
       FROM sessions s
       JOIN agents a ON a.id = s.agent_id
      WHERE a.slug = $1 AND s.status <> 'superseded'
      ORDER BY s.last_activity_at DESC NULLS LAST, s.created_at DESC
      LIMIT 1`,
    [agentSlug],
  );
  if (latest) {
    await pin(agentSlug, latest.id);
    return latest.id;
  }
  return null;
}

export async function sayToSimba(
  manager: SessionManager,
  opts: { text: string; surfaceId?: string | null },
): Promise<{ sessionId: string; started: boolean } | { error: string; sleepUntil?: Date }> {
  const text = opts.text.trim();
  if (!text) return { error: 'text required' };

  const existing = await getHomeSessionId();
  if (!existing) {
    const started = await manager.start({
      agent: HOME_AGENT,
      prompt: text,
      surfaceId: opts.surfaceId ?? null,
    });
    if ('error' in started) return started;
    await pin(HOME_AGENT, started.sessionId);
    return { sessionId: started.sessionId, started: true };
  }

  const { sessionId } = await manager.send(existing, text);
  if (sessionId !== existing) await pin(HOME_AGENT, sessionId);
  return { sessionId, started: false };
}

export async function loadToday(): Promise<TodayPayload> {
  const since = new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString();

  const [actions, blocked, captures, asks, sessions, missions, events, brief, home] =
    await Promise.all([
      query<{ id: string; action_class: string | null; summary: string | null; created_at: string }>(
        `SELECT id, action_class, summary, created_at
           FROM actions WHERE status = 'needs_confirmation'
           ORDER BY created_at DESC LIMIT 20`,
      ),
      query<{ id: string; title: string | null; status: string; updated_at: string | null }>(
        `SELECT id, title, status, updated_at FROM missions
          WHERE status = 'blocked' ORDER BY updated_at DESC NULLS LAST LIMIT 20`,
      ),
      query<{ id: string; source: string | null; title: string | null; content: string; status: string; created_at: string }>(
        `SELECT id, source, title, content, status, created_at FROM captures
          WHERE status = 'pending' ORDER BY created_at DESC LIMIT 20`,
      ),
      query<{ id: string; ask: string; status: string; created_at: string }>(
        `SELECT id, ask, status, created_at FROM requests
          WHERE status = 'open' ORDER BY created_at DESC LIMIT 20`,
      ),
      query<{ id: string; title: string | null; status: string; agent: string; last_activity_at: string | null }>(
        `SELECT s.id, s.title, s.status, a.slug AS agent, s.last_activity_at
           FROM sessions s JOIN agents a ON a.id = s.agent_id
          WHERE s.status IN ('running', 'idle')
          ORDER BY s.last_activity_at DESC NULLS LAST LIMIT 20`,
      ),
      query<{ id: string; title: string | null; status: string; updated_at: string | null }>(
        `SELECT id, title, status, updated_at FROM missions
          WHERE status IN ('running', 'planning')
          ORDER BY updated_at DESC NULLS LAST LIMIT 20`,
      ),
      query<{ id: string; type: string; message: string | null; at: string }>(
        `SELECT id::text, type, message, ts AS at FROM events
          WHERE ts >= $1
            AND type IN (
              'mission.completed','mission.blocked','mission.stopped',
              'capture.received','skill.learned','brain.limit_reached',
              'system.panic','session.revived'
            )
          ORDER BY ts DESC LIMIT 20`,
        [since],
      ),
      one<{ id: string; headline: string; body: string | null; created_at: string }>(
        `SELECT id, headline, body, created_at FROM briefs
          ORDER BY created_at DESC LIMIT 1`,
      ),
      getHomeSessionId(),
    ]);

  const needsMe: TodayItem[] = [
    ...actions.map((a) => ({
      kind: 'action' as const,
      id: a.id,
      title: a.summary || a.action_class || 'Approval waiting',
      detail: a.action_class,
      status: 'needs_confirmation',
      at: a.created_at,
    })),
    ...blocked.map((m) => ({
      kind: 'mission' as const,
      id: m.id,
      title: m.title || 'Mission blocked',
      detail: null,
      status: m.status,
      at: m.updated_at,
    })),
    ...captures.map((c) => ({
      kind: 'capture' as const,
      id: c.id,
      title: (c.title || c.content || c.source || 'Inbound').slice(0, 120),
      detail: c.source,
      status: c.status,
      at: c.created_at,
    })),
    ...asks.map((r) => ({
      kind: 'request' as const,
      id: r.id,
      title: (r.ask || 'Open request').slice(0, 120),
      detail: null,
      status: r.status,
      at: r.created_at,
    })),
  ];

  const running: TodayItem[] = [
    ...missions.map((m) => ({
      kind: 'mission' as const,
      id: m.id,
      title: m.title || 'Mission',
      detail: null,
      status: m.status,
      at: m.updated_at,
    })),
    ...sessions.map((s) => ({
      kind: 'session' as const,
      id: s.id,
      title: s.title || s.agent,
      detail: s.agent,
      status: s.status,
      at: s.last_activity_at,
    })),
  ];

  const overnight: TodayItem[] = [
    ...(brief
      ? [{
          kind: 'brief' as const,
          id: brief.id,
          title: brief.headline,
          detail: brief.body,
          status: null,
          at: brief.created_at,
        }]
      : []),
    ...events.map((e) => ({
      kind: 'event' as const,
      id: e.id,
      title: e.message || e.type,
      detail: e.type,
      status: null,
      at: e.at,
    })),
  ];

  return { needsMe, running, overnight, simba: { sessionId: home } };
}
