import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withRetry } from '../src/session/engine.js';

/**
 * Retry behaviour for durable writes.
 *
 * Every persistence error used to be logged to the console and discarded, so a
 * transient database fault lost transcript, tool and usage rows while the live
 * client saw the event arrive normally — the session looked healthy and its
 * record was quietly incomplete. Postgres is the source of truth here, which
 * makes a dropped write a correctness bug rather than a logging one:
 * checkpoints, hydration and cost accounting all read whatever survived.
 *
 * This imports the real policy rather than reimplementing it. The first version
 * of this file copied the retry loop into the test, which verifies nothing
 * about the code that ships — the copy passes happily while the original is
 * changed or deleted.
 *
 * backoffMs: 0 throughout. The delay is not what is under test, and a suite
 * that sleeps is a suite people stop running.
 */

describe('withRetry', () => {
  test('recovers from a transient failure instead of losing the write', async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('connection terminated unexpectedly');
      },
      { backoffMs: 0 },
    );
    assert.equal(r.error, null);
    assert.equal(r.attemptsUsed, 2);
  });

  test('reports the failure instead of swallowing it', async () => {
    const r = await withRetry(
      async () => {
        throw new Error('relation "messages" does not exist');
      },
      { backoffMs: 0 },
    );
    // The caller must be able to tell that data was lost. Returning cleanly
    // here is exactly the behaviour this replaced.
    assert.notEqual(r.error, null);
    assert.match(String((r.error as Error).message), /does not exist/);
    assert.equal(r.attemptsUsed, 3);
  });

  test('does not retry a success', async () => {
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
      },
      { backoffMs: 0 },
    );
    assert.equal(calls, 1, 'a successful write must be attempted exactly once');
  });

  test('honours a custom attempt count', async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls++;
        throw new Error('nope');
      },
      { attempts: 5, backoffMs: 0 },
    );
    assert.equal(calls, 5);
    assert.equal(r.attemptsUsed, 5);
  });

  test('surfaces the last error, not the first', async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls++;
        throw new Error(`failure ${calls}`);
      },
      { backoffMs: 0 },
    );
    assert.match(String((r.error as Error).message), /failure 3/);
  });
});
