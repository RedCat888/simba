/**
 * Exercises every router rule against a real database, then removes its traces.
 *
 * The router decides whether agents can talk to each other: TTL expiry, hop
 * limits, loop detection, per-pair flood control, escalation to Simba. All of
 * it is deterministic SQL, none of it had ever been run, and it carries no unit
 * tests because every rule is a query rather than a function.
 *
 * Worth checking despite no inter-agent traffic existing yet. These rules are
 * what stop two agents trading the same question until a subscription is gone,
 * so the cost of a wrong comparison is paid the first time it matters and not
 * before.
 *
 * Safe to run: it seeds rows with a probe- intent prefix, asserts, and deletes
 * everything it made in a finally - including the escalations raised to Simba,
 * which reference the original exchange through payload->>'correlationId'
 * rather than sharing its correlation_id. An earlier version of this probe
 * threw before its cleanup and left seven rows behind, which is why the
 * teardown is in a finally rather than at the end.
 *
 *   npx tsx scripts/probe-router.ts
 */

import { Router, DEFAULT_POLICY } from '../src/router/index.js';
import { query, one, closePool } from '../src/db/index.js';

const agents = await query<{ id: string; slug: string }>(
  `SELECT id, slug FROM agents WHERE retired_at IS NULL ORDER BY tier, slug LIMIT 2`);
const a = agents[0]!, b = agents[1]!;
console.log(`  exercising ${a.slug} -> ${b.slug}`);

const corrs: string[] = [];
const seed = async (sql: string, params: unknown[]) => {
  const row = await one<{ correlation_id: string }>(sql, params);
  corrs.push(row!.correlation_id);
  return row!.correlation_id;
};

let failures = 0;
try {
  const cExpire = await seed(
    `INSERT INTO inboxes (from_agent_id,to_agent_id,intent,created_at,expires_at)
     VALUES ($1,$2,'probe-expire', now()-interval '3 hours', now()-interval '1 hour')
     RETURNING correlation_id`, [a.id, b.id]);
  const cDefault = await seed(
    `INSERT INTO inboxes (from_agent_id,to_agent_id,intent,created_at)
     VALUES ($1,$2,'probe-default-ttl', now()-interval '3 hours') RETURNING correlation_id`, [a.id, b.id]);
  const cFresh = await seed(
    `INSERT INTO inboxes (from_agent_id,to_agent_id,intent) VALUES ($1,$2,'probe-fresh')
     RETURNING correlation_id`, [a.id, b.id]);
  const cHops = await seed(
    `INSERT INTO inboxes (from_agent_id,to_agent_id,intent,hop_count) VALUES ($1,$2,'probe-hops',$3)
     RETURNING correlation_id`, [a.id, b.id, DEFAULT_POLICY.maxHops]);
  const cUnderHops = await seed(
    `INSERT INTO inboxes (from_agent_id,to_agent_id,intent,hop_count) VALUES ($1,$2,'probe-underhops',$3)
     RETURNING correlation_id`, [a.id, b.id, DEFAULT_POLICY.maxHops - 1]);
  const cLoop = await seed(
    `INSERT INTO inboxes (from_agent_id,to_agent_id,intent) VALUES ($1,$2,'probe-loop-1')
     RETURNING correlation_id`, [a.id, b.id]);
  for (const n of [2, 3]) {
    await query(`INSERT INTO inboxes (from_agent_id,to_agent_id,intent,correlation_id)
                 VALUES ($1,$2,$3,$4)`, [a.id, b.id, `probe-loop-${n}`, cLoop]);
  }

  // No live sessions, so delivery has nobody to wake and only the rules run.
  const router = new Router({ listLive: () => [], getLive: () => undefined } as never);
  console.log('  stats:', JSON.stringify(await router.tick()));

  const check = async (label: string, corr: string, want: string) => {
    const rows = await query<{ status: string }>(
      `SELECT status FROM inboxes WHERE correlation_id=$1`, [corr]);
    const got = [...new Set(rows.map(r => r.status))].sort().join(',');
    const ok = got === want;
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} want=${want.padEnd(9)} got=${got}`);
  };
  await check('explicit TTL expires', cExpire, 'expired');
  await check('default 60m TTL expires', cDefault, 'expired');
  await check('fresh message survives', cFresh, 'pending');
  await check('at hop limit escalates', cHops, 'escalated');
  await check('under hop limit survives', cUnderHops, 'pending');
  await check('repeated pair escalates', cLoop, 'escalated');
} finally {
  const del = await query<{ id: string }>(
    `DELETE FROM inboxes
      WHERE correlation_id = ANY($1::uuid[])
         OR (intent='escalation' AND payload->>'correlationId' = ANY($1::text[]))
      RETURNING id`, [corrs]);
  const ev = await query<{ id: string }>(
    `DELETE FROM events WHERE type='router.escalated' AND data->>'correlationId' = ANY($1::text[])
     RETURNING id`, [corrs]);
  console.log(`  cleaned ${del.length} inbox rows, ${ev.length} events; failures=${failures}`);
  await closePool();
}
