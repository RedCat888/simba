import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query, one, closePool } from '../src/db/index.js';
import { buildHydrationBrief } from '../src/hydration/bundle.js';
import { OpenCodeRunner } from '../src/runner/opencode.js';
import type { LaunchSpec, RunnerEvent } from '../src/runner/types.js';

/**
 * Does memory actually reach an agent, and can it edit it?
 *
 * The point of bounded memory is that a fact is present without being searched
 * for. So the test asks something answerable *only* from the brief, with no
 * tool call available that would reveal it — if the agent has to look it up,
 * memory has failed at its one job.
 */
const agent = await one<{ id: string; slug: string }>(`SELECT id, slug FROM agents WHERE slug='scratch-worker'`);
const brief = await buildHydrationBrief(agent!.id, {});
const dir = mkdtempSync(join(tmpdir(), 'simba-mem-'));

const spec: LaunchSpec = {
  sessionId: '00000000-0000-0000-0000-0000000000ff',
  agentId: agent!.id,
  agentSlug: agent!.slug,
  brain: {
    id: '11111111-1111-1111-1111-111111111106',
    slug: 'opencode', provider: 'opencode', cli: 'opencode',
    configDir: null, env: {}, tierModels: { free: 'opencode/big-pickle' },
  },
  modelTier: 'free',
  cwd: dir,
  mcpConfigPath: 'generated',
  systemPromptAppend: brief,
  prompt:
    'Two things, without running any commands:\n' +
    '1. What Postgres user should be used on this machine, and which one does NOT exist? ' +
    'Answer from what you already know.\n' +
    '2. Then call memory_add to record this fact: kind "environment", content ' +
    '"The Android SDK is at C:/example-workspace/AppData/Local/Android/Sdk and the JDK ships with Android Studio at C:/Program Files/Android/Android Studio/jbr." ' +
    'Report what memory_add told you.',
};

const session = await new OpenCodeRunner().launch(spec);
const events: RunnerEvent[] = [];
for await (const e of session.events()) {
  events.push(e);
  if (e.kind === 'exit') break;
}

const reply = events.filter((e) => e.kind === 'text').map((e) => e.text).join('');
const tools = events.filter((e) => e.kind === 'tool_call').map((e) => e.name);

const errs = events.filter((e) => e.kind === 'error').map((e) => e.message);
const end = events.find((e) => e.kind === 'turn_end');
console.log('events       :', JSON.stringify(events.reduce<Record<string, number>>((a, e) => { a[e.kind] = (a[e.kind] ?? 0) + 1; return a; }, {})));
console.log('errors       :', errs.join(' | ').slice(0, 300) || '(none)');
if (end?.kind === 'turn_end') console.log('turn error   :', (end.error ?? '(none)').slice(0, 300));
console.log('tools called :', tools.join(', ') || '(none)');
console.log('reply        :', reply.replace(/\s+/g, ' ').slice(0, 300));
console.log('knew the fact:', /postgres/i.test(reply) && /simba/i.test(reply) ? 'yes' : 'NO');

const stored = await query<{ content: string }>(
  `SELECT content FROM agent_memory WHERE content ILIKE '%Android SDK%'`,
);
console.log('memory written:', stored.length > 0 ? 'yes — verified in Postgres' : 'NO');

await session.kill();
await closePool();
process.exit(0);
