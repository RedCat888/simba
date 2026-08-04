import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OpenCodeRunner } from '../src/runner/opencode.js';
import type { LaunchSpec, RunnerEvent } from '../src/runner/types.js';

/**
 * End-to-end check of the OpenCode runner.
 *
 * Two turns rather than one, because the interesting claim is not "it answers"
 * — the completion provider already proved that — but that a *session* survives
 * between two separate processes. `opencode run` exits after every turn, so
 * continuity depends entirely on capturing the native session id from the event
 * stream and passing it back with `-s`. Asking turn two about something only
 * turn one was told is the only honest test of that.
 */

const dir = mkdtempSync(join(tmpdir(), 'simba-ocprobe-'));
writeFileSync(join(dir, 'secret.txt'), 'the passphrase is copper-lantern-42\n', 'utf8');

const spec: LaunchSpec = {
  sessionId: '00000000-0000-0000-0000-0000000000aa',
  agentId: '00000000-0000-0000-0000-0000000000bb',
  agentSlug: 'probe',
  brain: {
    id: '11111111-1111-1111-1111-111111111106',
    slug: 'opencode',
    provider: 'opencode',
    cli: 'opencode',
    configDir: null,
    env: {},
    tierModels: { free: 'opencode/big-pickle' },
  },
  modelTier: 'free',
  cwd: dir,
};

/**
 * One consumer for the whole session, not one per turn.
 *
 * AsyncQueue.return() closes the queue, and `break` inside a `for await` calls
 * it — so consuming turn one with its own loop and breaking on `exit` silently
 * kills the stream, and every later turn reports nothing. That is the contract
 * the session engine already follows; this mirrors it. Turns are separated by
 * counting `exit` events rather than by tearing the iterator down.
 */
function consume(session: { events(): AsyncIterableIterator<RunnerEvent> }) {
  const turns: RunnerEvent[][] = [[]];
  let notify: (() => void) | null = null;

  void (async () => {
    for await (const e of session.events()) {
      turns[turns.length - 1].push(e);
      if (e.kind === 'exit') {
        turns.push([]);
        notify?.();
      }
    }
  })();

  return {
    turns,
    /** Resolves when the turn currently in flight emits its exit. */
    nextTurn(): Promise<RunnerEvent[]> {
      const index = turns.length - 1;
      return new Promise((resolve) => {
        notify = () => {
          notify = null;
          resolve(turns[index]);
        };
      });
    },
  };
}

function summarize(events: RunnerEvent[]) {
  const kinds = events.reduce<Record<string, number>>((a, e) => {
    a[e.kind] = (a[e.kind] ?? 0) + 1;
    return a;
  }, {});
  return {
    kinds,
    text: events.filter((e) => e.kind === 'text').map((e) => e.text).join(''),
    tools: events.filter((e) => e.kind === 'tool_call').map((e) => e.name),
    end: events.find((e) => e.kind === 'turn_end'),
    errors: events.filter((e) => e.kind === 'error').map((e) => e.message),
  };
}

const runner = new OpenCodeRunner();
const t0 = Date.now();

const session = await runner.launch({
  ...spec,
  prompt: 'Read secret.txt in the current directory and tell me the passphrase.',
});

const stream = consume(session);
const one = summarize(await stream.nextTurn());

console.log('--- turn 1 ---');
console.log('events      ', JSON.stringify(one.kinds));
console.log('native id   ', session.nativeSessionId);
console.log('tools       ', one.tools.join(', ') || '(none)');
console.log('text        ', one.text.replace(/\s+/g, ' ').slice(0, 120));
console.log('read file   ', /copper-lantern-42/.test(one.text) ? 'YES' : 'NO');
if (one.end?.kind === 'turn_end') {
  console.log('cost        ', one.end.usage?.costUsd);
  console.log('tokens      ', one.end.usage?.inputTokens, 'in /', one.end.usage?.outputTokens, 'out');
}
console.log('errors      ', one.errors.join(' | ') || '(none)');

// Turn two: a fresh process resuming the same native session. This prompt never
// mentions the passphrase, so recalling it is the proof that resume worked.
const nativeBefore = session.nativeSessionId;
const pending = stream.nextTurn();
await session.send('What was the passphrase you just read? Answer with only the passphrase.');
const two = summarize(await pending);

console.log('--- turn 2 (resume) ---');
console.log(
  'native id   ',
  session.nativeSessionId,
  session.nativeSessionId === nativeBefore ? '(same)' : '(CHANGED)',
);
console.log('events      ', JSON.stringify(two.kinds));
console.log('text        ', two.text.replace(/\s+/g, ' ').slice(0, 120));
console.log('errors      ', two.errors.join(' | ') || '(none)');
console.log('remembered  ', /copper-lantern-42/.test(two.text) ? 'YES — resume works' : 'NO — resume broken');
console.log('total       ', Math.round((Date.now() - t0) / 1000), 's');

await session.kill();
process.exit(0);
