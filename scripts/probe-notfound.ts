/**
 * Does every write route admit when it changed nothing?
 *
 * The captures resolve route ran its UPDATE and answered {ok:true} without
 * checking whether any row matched, so acting on a deleted or mistyped id was
 * indistinguishable from acting on a real one — and the caller dropped the row
 * from view believing it had worked. Reading the code did not find that. Asking
 * every route the same question did.
 *
 * So this asks all of them: given an id that certainly does not exist, do you
 * say so? A 404 or a 4xx is a pass. A 200 is the bug. A 500 is a different bug —
 * a missing row should not be an exception — and is reported separately.
 *
 *   npx tsx scripts/probe-notfound.ts
 */

const BASE = process.env.SIMBA_URL ?? 'http://127.0.0.1:8787';

/** Certainly absent: a well-formed uuid that nothing will ever be keyed on. */
const GHOST_ID = '00000000-0000-0000-0000-000000000000';
const GHOST_SLUG = 'no-such-thing-probe';

interface Probe {
  path: string;
  body?: unknown;
  /** Routes that legitimately answer 200 for an absent id, with the reason. */
  expected?: number;
  why?: string;
}

const PROBES: Probe[] = [
  { path: `/api/captures/${GHOST_ID}/done` },
  { path: `/api/requests/${GHOST_ID}/done` },
  { path: `/api/missions/${GHOST_ID}/pause` },
  { path: `/api/briefs/${GHOST_ID}/ack` },
  { path: `/api/actions/${GHOST_ID}/confirm`, body: { approve: false } },
  { path: `/api/sessions/${GHOST_ID}/kill` },
  { path: `/api/sessions/${GHOST_ID}/send`, body: { text: 'probe' } },
  { path: `/api/sessions/${GHOST_ID}/failover` },
  { path: `/api/brains/${GHOST_SLUG}/toggle` },
  { path: `/api/agents/${GHOST_SLUG}/model`, body: { modelTier: 'low' } },
];

const results: Array<{ path: string; status: number; verdict: string; body: string }> = [];

for (const p of PROBES) {
  let status = 0;
  let text = '';
  try {
    const res = await fetch(BASE + p.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(p.body ?? {}),
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
    text = (await res.text()).slice(0, 90).replace(/\s+/g, ' ');
  } catch (err) {
    text = `request failed: ${err}`;
  }

  const verdict =
    status === 200 ? 'SILENT SUCCESS'
      : status >= 500 ? 'server error'
        : status >= 400 ? 'ok — says so'
          : `unexpected ${status}`;
  results.push({ path: p.path.replace(GHOST_ID, '<ghost>').replace(GHOST_SLUG, '<ghost>'), status, verdict, body: text });
}

for (const r of results) {
  console.log(`${String(r.status).padEnd(4)} ${r.verdict.padEnd(15)} ${r.path}`);
  if (r.verdict !== 'ok — says so') console.log(`      ${r.body}`);
}

const bad = results.filter((r) => r.verdict === 'SILENT SUCCESS');
const errs = results.filter((r) => r.verdict === 'server error');
console.log(`\n${results.length} probed · ${bad.length} silent success · ${errs.length} server error`);
