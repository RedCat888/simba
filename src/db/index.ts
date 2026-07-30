import pg from 'pg';
import { config } from '../config.js';

/**
 * Postgres access. Local is authoritative; the Supabase mirror (later) is a
 * downstream replica fed from an outbox, never a second writer.
 */

// Return numeric/int8 as JS numbers rather than strings. Token counts and costs
// are read far more often than they are summed to precision-critical totals,
// and every call site otherwise has to remember to parse.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

export const pool = new pg.Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: config.db.max,
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Append-only audit. Deliberately never throws: losing an audit row must not
 * take down the operation being audited, and a failure here is itself
 * interesting enough to log to stderr.
 */
export async function recordEvent(e: {
  type: string;
  severity?: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  agentId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  brainAccountId?: string | null;
  nodeId?: string | null;
  message?: string | null;
  data?: unknown;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO events (type, severity, agent_id, session_id, turn_id,
                           brain_account_id, node_id, message, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        e.type,
        e.severity ?? 'info',
        e.agentId ?? null,
        e.sessionId ?? null,
        e.turnId ?? null,
        e.brainAccountId ?? null,
        e.nodeId ?? null,
        e.message ?? null,
        JSON.stringify(e.data ?? {}),
      ],
    );
  } catch (err) {
    console.error('[db] failed to record event', e.type, err);
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
