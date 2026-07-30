import { query, one, recordEvent } from '../db/index.js';
import type { SessionManager } from '../session/manager.js';

/**
 * The inter-agent router.
 *
 * Not a group chat. Agents address each other directly; this component sits in
 * the middle, decides whether a message is worth waking someone for, notices
 * when two agents are going in circles, and escalates instead of letting an
 * exchange retry forever.
 *
 * Every rule here is deterministic — counters, timestamps and table lookups.
 * Paying a model to notice that two agents have swapped the same question four
 * times is exactly the kind of spend that makes a $20 plan run out, and a
 * counter is both cheaper and more reliable at it.
 */

export interface RouterPolicy {
  /** Chain length before an exchange is escalated rather than continued. */
  maxHops: number;
  /** Times one ordered pair may appear in a correlation before it reads as a loop. */
  maxPairRepeats: number;
  /** Messages one pair may exchange per window, regardless of correlation. */
  maxPerPairPerWindow: number;
  windowMinutes: number;
  /** Default lifetime for a message with no explicit TTL. */
  defaultTtlMinutes: number;
}

export const DEFAULT_POLICY: RouterPolicy = {
  maxHops: 5,
  maxPairRepeats: 2,
  maxPerPairPerWindow: 12,
  windowMinutes: 10,
  defaultTtlMinutes: 60,
};

export interface RouterStats {
  delivered: number;
  injected: number;
  woken: number;
  escalated: number;
  expired: number;
}

export class Router {
  constructor(
    private readonly manager: SessionManager,
    private readonly policy: RouterPolicy = DEFAULT_POLICY,
  ) {}

  async tick(): Promise<RouterStats> {
    const stats: RouterStats = { delivered: 0, injected: 0, woken: 0, escalated: 0, expired: 0 };

    stats.expired += await this.expire();
    stats.escalated += await this.escalateHopLimit();
    stats.escalated += await this.escalateLoops();
    stats.escalated += await this.escalateFloods();

    const delivery = await this.deliver();
    stats.delivered += delivery.delivered;
    stats.injected += delivery.injected;
    stats.woken += delivery.woken;

    return stats;
  }

  /** TTL sweep. A question nobody answered in an hour is stale, not pending. */
  private async expire(): Promise<number> {
    const rows = await query<{ id: string }>(
      `UPDATE inboxes
          SET status = 'expired'
        WHERE status = 'pending'
          AND coalesce(
                expires_at,
                created_at + ($1 || ' minutes')::interval
              ) < now()
        RETURNING id`,
      [String(this.policy.defaultTtlMinutes)],
    );
    return rows.length;
  }

  /** A chain that has bounced too many times stops being productive. */
  private async escalateHopLimit(): Promise<number> {
    const rows = await query<{ id: string; correlation_id: string; to_agent_id: string }>(
      `UPDATE inboxes
          SET status = 'escalated',
              escalation_reason = 'hop limit reached'
        WHERE status = 'pending' AND hop_count >= $1
        RETURNING id, correlation_id, to_agent_id`,
      [this.policy.maxHops],
    );
    for (const r of rows) await this.notifySimba(r.correlation_id, 'hop limit reached');
    return rows.length;
  }

  /**
   * Loop detection. Within one correlation, the same ordered pair appearing
   * repeatedly means the same question is being re-asked rather than answered.
   */
  private async escalateLoops(): Promise<number> {
    const looping = await query<{ correlation_id: string; from_agent_id: string; to_agent_id: string }>(
      `SELECT correlation_id, from_agent_id, to_agent_id
         FROM inboxes
        WHERE from_agent_id IS NOT NULL
        GROUP BY correlation_id, from_agent_id, to_agent_id
       HAVING count(*) > $1
          AND bool_or(status = 'pending')`,
      [this.policy.maxPairRepeats],
    );

    let n = 0;
    for (const l of looping) {
      const rows = await query<{ id: string }>(
        `UPDATE inboxes
            SET status = 'escalated',
                escalation_reason = 'loop detected: same pair repeated within one exchange'
          WHERE status = 'pending' AND correlation_id = $1
          RETURNING id`,
        [l.correlation_id],
      );
      n += rows.length;
      if (rows.length > 0) {
        await this.notifySimba(l.correlation_id, 'two agents were going in circles');
      }
    }
    return n;
  }

  /** Volume guard, independent of any single correlation. */
  private async escalateFloods(): Promise<number> {
    const flooding = await query<{ from_agent_id: string; to_agent_id: string; n: number }>(
      `SELECT from_agent_id, to_agent_id, count(*)::int AS n
         FROM inboxes
        WHERE from_agent_id IS NOT NULL
          AND created_at > now() - ($1 || ' minutes')::interval
        GROUP BY from_agent_id, to_agent_id
       HAVING count(*) > $2`,
      [String(this.policy.windowMinutes), this.policy.maxPerPairPerWindow],
    );

    let n = 0;
    for (const f of flooding) {
      const rows = await query<{ id: string }>(
        `UPDATE inboxes
            SET status = 'escalated',
                escalation_reason = 'message flood between one pair of agents'
          WHERE status = 'pending' AND from_agent_id = $1 AND to_agent_id = $2
          RETURNING id`,
        [f.from_agent_id, f.to_agent_id],
      );
      n += rows.length;
      if (rows.length > 0) {
        await recordEvent({
          type: 'router.flood',
          severity: 'warn',
          agentId: f.from_agent_id,
          message: `${f.n} messages to one agent in ${this.policy.windowMinutes}m; paused`,
        });
      }
    }
    return n;
  }

  /**
   * Delivery.
   *
   * A message to an agent that is already running is injected into its live
   * session — cheaper and faster than spawning anything. A message flagged to
   * wake a sleeping agent starts a session. Anything else simply waits: the
   * agent will call inbox_read when it next runs, which is the whole point of
   * having an inbox rather than a notification.
   */
  private async deliver(): Promise<{ delivered: number; injected: number; woken: number }> {
    const pending = await query<{
      id: string;
      to_agent_id: string;
      to_slug: string;
      from_slug: string | null;
      intent: string;
      payload: Record<string, unknown>;
      wake_target: boolean;
      agent_status: string;
    }>(
      `SELECT i.id, i.to_agent_id, t.slug AS to_slug, f.slug AS from_slug,
              i.intent, i.payload, i.wake_target, t.status AS agent_status
         FROM inboxes i
         JOIN agents t ON t.id = i.to_agent_id
         LEFT JOIN agents f ON f.id = i.from_agent_id
        WHERE i.status = 'pending'
        ORDER BY i.priority, i.created_at
        LIMIT 10`,
    );

    let delivered = 0;
    let injected = 0;
    let woken = 0;

    for (const msg of pending) {
      const live = this.manager
        .listLive()
        .find((s) => s.agentId === msg.to_agent_id);

      if (live) {
        const body =
          `[message from ${msg.from_slug ?? 'simba'} — intent: ${msg.intent}]\n` +
          `${JSON.stringify(msg.payload, null, 2)}\n\n` +
          `Respond if it needs a response, otherwise carry on with what you were doing.`;
        try {
          await this.manager.send(live.sessionId, body);
          await this.markDelivered(msg.id);
          injected += 1;
          delivered += 1;
          continue;
        } catch {
          // Session died between the lookup and the send; fall through and let
          // it wait for the next run rather than losing the message.
        }
      }

      if (msg.wake_target && ['idle', 'sleeping'].includes(msg.agent_status)) {
        const result = await this.manager.start({
          agent: msg.to_slug,
          prompt:
            'You were woken by another agent. Call inbox_read to see what they need, act on it, ' +
            'and reply with agent_message if a response is expected.',
        });
        if ('sessionId' in result) {
          await this.markDelivered(msg.id);
          woken += 1;
          delivered += 1;
          await recordEvent({
            type: 'agent.woken',
            agentId: msg.to_agent_id,
            sessionId: result.sessionId,
            message: `woken by ${msg.from_slug ?? 'simba'} for "${msg.intent}"`,
          });
        }
      }
      // Otherwise: leave pending. inbox_read will pick it up.
    }

    return { delivered, injected, woken };
  }

  private async markDelivered(id: string): Promise<void> {
    await query(
      `UPDATE inboxes SET status = 'delivered', delivered_at = now() WHERE id = $1`,
      [id],
    );
  }

  /**
   * Escalation target. Simba is told, rather than the exchange being retried or
   * dropped silently — an agent conversation that failed is a signal about the
   * work, not noise to suppress.
   */
  private async notifySimba(correlationId: string, reason: string): Promise<void> {
    const simba = await one<{ id: string }>(
      `SELECT id FROM agents WHERE slug = 'simba' AND retired_at IS NULL`,
    );
    if (!simba) return;

    const context = await query<{ from_slug: string | null; to_slug: string; intent: string }>(
      `SELECT f.slug AS from_slug, t.slug AS to_slug, i.intent
         FROM inboxes i
         JOIN agents t ON t.id = i.to_agent_id
         LEFT JOIN agents f ON f.id = i.from_agent_id
        WHERE i.correlation_id = $1
        ORDER BY i.created_at
        LIMIT 10`,
      [correlationId],
    );

    await query(
      `INSERT INTO inboxes (from_agent_id, to_agent_id, intent, payload, priority, wake_target)
       VALUES (NULL, $1, 'escalation', $2, 1, false)`,
      [
        simba.id,
        JSON.stringify({
          reason,
          correlationId,
          exchange: context.map((c) => `${c.from_slug ?? '?'} -> ${c.to_slug}: ${c.intent}`),
        }),
      ],
    );

    await recordEvent({
      type: 'router.escalated',
      severity: 'warn',
      message: `escalated to Simba: ${reason}`,
      data: { correlationId, hops: context.length },
    });
  }
}
