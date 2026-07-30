import { query, closePool } from './db/index.js';
import { recall } from './knowledge/embed.js';

/**
 * Admin CLI for driving Simba from this machine without the app.
 *
 *   npm run simba -- status
 *   npm run simba -- agents
 *   npm run simba -- brains
 *   npm run simba -- sessions [agent-slug]
 *   npm run simba -- search <query>
 *   npm run simba -- transcript <session-id>
 *   npm run simba -- events [n]
 */

const [, , cmd, ...rest] = process.argv;
const arg = rest.join(' ');

function table(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  console.table(rows);
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'status': {
      const [s] = await query(
        `SELECT
           (SELECT count(*) FROM agents WHERE retired_at IS NULL)                 AS agents,
           (SELECT count(*) FROM sessions WHERE status IN ('running','idle'))     AS active,
           (SELECT count(*) FROM sessions)                                        AS sessions,
           (SELECT count(*) FROM messages)                                        AS messages,
           (SELECT count(*) FROM tool_calls)                                      AS tool_calls,
           (SELECT count(*) FROM checkpoints)                                     AS checkpoints,
           (SELECT count(*) FROM knowledge_items)                                 AS knowledge,
           (SELECT count(*) FROM embeddings)                                      AS vectors,
           (SELECT round(coalesce(sum(total_cost_usd),0)::numeric, 4) FROM sessions) AS spent_usd`,
      );
      console.log(s);
      break;
    }

    case 'agents':
      table(
        await query(
          `SELECT a.slug, a.tier, a.domain, a.status, a.model_tier,
                  (SELECT count(*) FROM sessions s WHERE s.agent_id = a.id) AS sessions
             FROM agents a WHERE a.retired_at IS NULL ORDER BY a.tier, a.slug`,
        ),
      );
      break;

    case 'brains':
      table(
        await query(
          `SELECT b.slug, b.provider, b.cli, b.status, b.priority,
                  b.limit_resets_at,
                  round(coalesce(u.cost_5h,0)::numeric, 4) AS cost_5h,
                  round(coalesce(u.cost_7d,0)::numeric, 4) AS cost_7d
             FROM brain_accounts b
             LEFT JOIN usage_windows u ON u.brain_account_id = b.id
            ORDER BY b.priority`,
        ),
      );
      break;

    case 'sessions':
      table(
        await query(
          `SELECT left(s.id::text, 8) AS id, a.slug AS agent, s.status,
                  coalesce(s.title, '-') AS title, s.swap_count,
                  round(s.total_cost_usd::numeric, 4) AS cost, s.last_activity_at
             FROM sessions s JOIN agents a ON a.id = s.agent_id
            WHERE ($1 = '' OR a.slug = $1)
            ORDER BY s.created_at DESC LIMIT 25`,
          [arg],
        ),
      );
      break;

    case 'transcript': {
      if (!arg) throw new Error('usage: transcript <session-id>');
      const rows = await query<{ seq: number; role: string; content: string | null }>(
        `SELECT seq, role, content FROM messages
          WHERE session_id::text LIKE $1 || '%' AND content IS NOT NULL
          ORDER BY seq`,
        [arg],
      );
      for (const r of rows) console.log(`\n[${r.seq} ${r.role}]\n${r.content}`);
      break;
    }

    case 'search': {
      if (!arg) throw new Error('usage: search <query>');
      const hits = await recall(arg, { limit: 8 });
      if (hits.length === 0) {
        console.log('No semantic hits. Is Ollama running and the corpus ingested?');
        break;
      }
      for (const h of hits) {
        console.log(
          `\n[${(1 - h.distance).toFixed(3)}] ${h.title ?? '?'}  (${h.source})\n` +
            `  ${h.content.slice(0, 240).replace(/\s+/g, ' ')}`,
        );
      }
      break;
    }

    case 'events':
      table(
        await query(
          `SELECT to_char(ts, 'MM-DD HH24:MI:SS') AS at, type, severity,
                  left(coalesce(message, ''), 70) AS message
             FROM events ORDER BY ts DESC LIMIT $1`,
          [Number(arg) || 25],
        ),
      );
      break;

    default:
      console.log(
        'commands: status | agents | brains | sessions [agent] | search <q> | transcript <id> | events [n]',
      );
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
