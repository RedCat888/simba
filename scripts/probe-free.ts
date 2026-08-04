import { opencodeComplete } from '../src/hydration/opencode.js';

/**
 * Measures how reliable the free tier actually is.
 *
 * Worth knowing rather than assuming: probing found two of four advertised
 * free models returning server errors outright, so the question is not "does it
 * work" but "how often". That number decides whether it belongs first in the
 * chain or as an opportunistic extra.
 */
const N = Number(process.argv[2] ?? 5);
let ok = 0;
const times: number[] = [];

for (let i = 0; i < N; i++) {
  const t = Date.now();
  const r = await opencodeComplete('Reply with exactly OK and nothing else.', 60_000);
  if (r) {
    ok += 1;
    times.push(Date.now() - t);
  }
}

const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
console.log(`free tier: ${ok}/${N} succeeded, avg ${avg}ms`);
process.exit(0);
