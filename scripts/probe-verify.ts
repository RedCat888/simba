import { verifyBrain } from '../src/runner/verify.js';
import { closePool } from '../src/db/index.js';

/**
 * Checks the verifier itself, not the brains.
 *
 * It has already produced two wrong answers: a cursor turn that returned
 * "result":"OK" was reported as an entitlement failure because "403" matched
 * inside a request UUID, and the resolved-model field came back null for a
 * brain whose output plainly contains it. A verifier that invents faults is
 * worse than none, since its whole purpose is correcting a wrong stored status.
 */
for (const slug of process.argv.slice(2)) {
  const r = await verifyBrain(slug);
  console.log(
    `${slug.padEnd(10)} ok=${String(r.ok).padEnd(5)} asked=${String(r.model).padEnd(28)} ` +
      `got=${String(r.resolvedModel).padEnd(24)} drift=${r.drift}`,
  );
  if (!r.ok) console.log(`           ${r.detail.slice(0, 200)}`);
}
await closePool();
process.exit(0);
