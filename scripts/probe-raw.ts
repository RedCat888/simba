import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolveExecutor, buildSpawn } from '../src/runner/discovery.js';

const bin = await resolveExecutor('claude');
if (!bin) throw new Error('no claude');
const inv = buildSpawn(bin.path, [
  ...bin.prefixArgs, '-p', 'Reply with exactly OK',
  '--output-format', 'json', '--strict-mcp-config', '--model', 'claude-opus-5',
]);
const out = await new Promise<string>((res) => {
  const p = spawn(inv.command, inv.args, {
    cwd: tmpdir(), windowsHide: true, windowsVerbatimArguments: inv.windowsVerbatimArguments,
  });
  let o = '';
  try { p.stdin.end(); } catch { /* closed */ }
  p.stdout.on('data', (c: Buffer) => (o += c.toString()));
  p.stderr.on('data', (c: Buffer) => (o += c.toString()));
  p.on('close', () => res(o));
});
console.log('bytes:', out.length);
console.log('contains "model":', out.includes('"model"'));
console.log('matches:', [...out.matchAll(/"model"\s*:\s*"([^"]+)"/g)].map((m) => m[1]));
console.log('head:', out.slice(0, 200));
process.exit(0);
