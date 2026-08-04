import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OpenCodeRunner } from '../src/runner/opencode.js';
import type { LaunchSpec, RunnerEvent } from '../src/runner/types.js';

/**
 * Can an OpenCode worker reach Simba's own tools?
 *
 * This is the difference between a free completion endpoint and a free *runner*.
 * A worker that cannot read Simba's memory or record what it did is not an agent
 * in this system, it is a text generator. OpenCode has no --mcp-config flag, so
 * the adapter generates a config and points OPENCODE_CONFIG at it; this checks
 * that the server is actually loaded and callable, not merely declared.
 */

const dir = mkdtempSync(join(tmpdir(), 'simba-ocmcp-'));

const spec: LaunchSpec = {
  sessionId: '00000000-0000-0000-0000-0000000000cc',
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
  // Truthy: the adapter generates its own config from this, it is not read.
  mcpConfigPath: 'generated',
  prompt:
    'List the names of every tool you have available whose name starts with "simba". ' +
    'Then call the one that records a note or memory, if you have it, and say what happened. ' +
    'Be brief.',
};

const runner = new OpenCodeRunner();
const session = await runner.launch(spec);

const events: RunnerEvent[] = [];
for await (const e of session.events()) {
  events.push(e);
  if (e.kind === 'exit') break;
}

const text = events.filter((e) => e.kind === 'text').map((e) => e.text).join('');
const tools = events.filter((e) => e.kind === 'tool_call').map((e) => e.name);
const errors = events.filter((e) => e.kind === 'error').map((e) => e.message);

console.log('tools called:', tools.join(', ') || '(none)');
console.log('errors      :', errors.join(' | ') || '(none)');
console.log('reply       :', text.replace(/\s+/g, ' ').slice(0, 600));
console.log(
  'verdict     :',
  /simba/i.test(text) || tools.some((t) => /simba/i.test(t))
    ? 'MCP server visible to the worker'
    : 'NO simba tools reached the worker',
);

process.exit(0);
