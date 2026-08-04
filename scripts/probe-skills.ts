import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query, one, closePool } from '../src/db/index.js';
import { buildHydrationBrief } from '../src/hydration/bundle.js';
import { OpenCodeRunner } from '../src/runner/opencode.js';
import type { LaunchSpec, RunnerEvent } from '../src/runner/types.js';

/**
 * Does the skills loop actually close?
 *
 * Three claims, each checked against the database rather than the model's own
 * account of what it did:
 *   1. the index reaches an agent's brief, and carries summaries not bodies;
 *   2. an agent can open a skill it only saw one line of;
 *   3. an agent can write a new skill that survives the session.
 *
 * Run on the free tier deliberately — if learning costs subscription headroom
 * every time an agent notices something, it will not be left switched on.
 */

const agent = await one<{ id: string; slug: string }>(
  `SELECT id, slug FROM agents ORDER BY tier, slug LIMIT 1`,
);
if (!agent) throw new Error('no agents defined');

// ---- 1. the index reaches the brief ---------------------------------------
const brief = await buildHydrationBrief(agent.id, {});
const hasSection = /## Skills/.test(brief);
const hasEntry = /windows-cli-hangs-on-stdin/.test(brief);
// The body of that skill contains this line; it must NOT be in the brief.
const leakedBody = /proc\.stdin\.end\(\)/.test(brief);

console.log('--- 1. brief ---');
console.log('agent            ', agent.slug);
console.log('Skills section   ', hasSection ? 'present' : 'MISSING');
console.log('index entry      ', hasEntry ? 'present' : 'MISSING');
console.log('bodies kept out  ', leakedBody ? 'NO — body leaked into the prompt' : 'yes');
console.log('brief size       ', brief.length, 'chars');

// ---- 2 & 3. an agent uses and extends the store ---------------------------
const dir = mkdtempSync(join(tmpdir(), 'simba-skills-'));

const spec: LaunchSpec = {
  sessionId: '00000000-0000-0000-0000-0000000000dd',
  agentId: agent.id,
  agentSlug: agent.slug,
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
  mcpConfigPath: 'generated',
  systemPromptAppend: brief,
  prompt:
    'Do exactly two things and report what happened.\n' +
    '1. Call skill_view for the skill named windows-cli-hangs-on-stdin and tell me, in one ' +
    'sentence, what fix it prescribes.\n' +
    '2. Call skill_save to record a NEW skill named postgres-psql-on-this-box with the ' +
    'description "Use when you need to query Simba\'s Postgres from a script." and a body ' +
    'explaining that psql lives at C:\\Users\\operator\\scoop\\apps\\postgresql\\current\\bin\\psql.exe, ' +
    'that the database is simba, and that the user is postgres — not simba, which does not exist.',
};

const runner = new OpenCodeRunner();
const session = await runner.launch(spec);

const events: RunnerEvent[] = [];
for await (const e of session.events()) {
  events.push(e);
  if (e.kind === 'exit') break;
}

const tools = events.filter((e) => e.kind === 'tool_call').map((e) => e.name);
const reply = events.filter((e) => e.kind === 'text').map((e) => e.text).join('');

const kinds = events.reduce<Record<string, number>>((a, e) => {
  a[e.kind] = (a[e.kind] ?? 0) + 1;
  return a;
}, {});
const errors = events.filter((e) => e.kind === 'error').map((e) => e.message);
const end = events.find((e) => e.kind === 'turn_end');

console.log('--- 2/3. agent run ---');
console.log('events           ', JSON.stringify(kinds));
console.log('tools called     ', tools.join(', ') || '(none)');
console.log('errors           ', errors.join(' | ').slice(0, 400) || '(none)');
if (end?.kind === 'turn_end') console.log('turn error       ', (end.error ?? '(none)').slice(0, 400));
console.log('reply            ', reply.replace(/\s+/g, ' ').slice(0, 260));

// ---- verified against Postgres, not against the reply ---------------------
const saved = await one<{ name: string; version: number; source: string; description: string }>(
  `SELECT name, version, source, description FROM skills WHERE name = 'postgres-psql-on-this-box'`,
);
const viewed = await one<{ use_count: number }>(
  `SELECT use_count FROM skills WHERE name = 'windows-cli-hangs-on-stdin'`,
);
const revisions = await query<{ version: number }>(
  `SELECT r.version FROM skill_revisions r JOIN skills s ON s.id = r.skill_id
    WHERE s.name = 'postgres-psql-on-this-box'`,
);

console.log('--- verified in postgres ---');
console.log('skill written    ', saved ? `yes — ${saved.name} v${saved.version} (${saved.source})` : 'NO');
console.log('revision kept    ', revisions.length > 0 ? `yes (v${revisions.map((r) => r.version).join(',')})` : 'NO');
console.log('view recorded    ', viewed ? `use_count = ${viewed.use_count}` : 'NO');

await session.kill();
await closePool();
process.exit(0);
