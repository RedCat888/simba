import { randomUUID } from 'node:crypto';

import { query, closePool } from '../src/db/index.js';
import { getSurface, claimSessionSlot } from '../src/policy/surface.js';

/**
 * Can two simultaneous starts both claim the last slot?
 *
 * canReachAgent counts and then the caller inserts — two statements, so two
 * requests arriving together both see room and both proceed. On the phone
 * surface, limited to one session, that is the difference between the ceiling
 * meaning something and not.
 *
 * Fired concurrently rather than sequentially on purpose: run one after the
 * other and the broken version passes too.
 */
const surface = await getSurface('phone');
if (!surface) throw new Error('phone surface missing');

const agent = await query<{ id: string; node_id: string | null }>(
  `SELECT id, node_id FROM agents WHERE slug = 'scratch-worker'`,
);
const a = agent[0]!;
const brain = await query<{ id: string }>(`SELECT id FROM brain_accounts WHERE slug='opencode'`);

// Start from a clean slate so the limit is what is being measured.
await query(
  `DELETE FROM sessions WHERE origin_surface_id = $1 AND cli = 'ceilingprobe'`,
  [surface.id],
);

const ids = [randomUUID(), randomUUID(), randomUUID()];
const mk = (id: string) => ({
  sessionId: id,
  agentId: a.id,
  cli: 'ceilingprobe',
  brainId: brain[0]!.id,
  nodeId: a.node_id,
  projectId: null,
  cwd: 'C:/tmp',
  continuingSessionId: null,
  swapCount: 0,
});

// Test at the boundary, not below it. The phone surface allows 10, so three
// concurrent claims all succeeding says nothing about the limit — a broken
// check-then-act passes that too. Squeeze it to 1 for the duration.
const realLimit = surface.max_concurrent_sessions;
const tight = { ...surface, max_concurrent_sessions: 1 };

const results = await Promise.all(ids.map((id) => claimSessionSlot(tight, mk(id))));
const granted = results.filter(Boolean).length;

const actual = await query<{ n: number }>(
  `SELECT count(*)::int AS n FROM sessions
    WHERE origin_surface_id = $1 AND cli = 'ceilingprobe'
      AND status IN ('running','idle','pending')`,
  [surface.id],
);

console.log('real limit ', realLimit);
console.log('limit used ', tight.max_concurrent_sessions);
console.log('attempted  ', ids.length, '(concurrently)');
console.log('granted    ', granted);
console.log('rows made  ', actual[0]?.n);
console.log(
  'verdict    ',
  granted === 1 && actual[0]?.n === 1
    ? 'exactly one claim won — ceiling held'
    : 'CEILING BREACHED',
);

await query(`DELETE FROM sessions WHERE cli = 'ceilingprobe'`);
await closePool();
process.exit(0);
