/**
 * Speaks MCP to src/mcp/server.ts over stdio and exercises the mission tools.
 *
 * The handlers are inside a switch in a module that connects a StdioServerTransport
 * on import, so they cannot be called directly without starting a server. Talking
 * to it the way an agent does is both easier and a better test.
 */
import { spawn } from 'node:child_process';
import { query, one, closePool } from '../src/db/index.js';

const SLUG = 'probe-planguard';
await query(`DELETE FROM missions WHERE slug = $1`, [SLUG]);
const m = await one<{ id: string }>(
  `INSERT INTO missions (slug, title, objective, status, max_concurrent_sessions, max_sessions, max_cost_usd)
   VALUES ($1,'probe planguard','probe','planning',0,99,99) RETURNING id`, [SLUG]);
const id = m!.id;

const proc = spawn('npx', ['tsx', 'src/mcp/server.ts'], { shell: true, windowsHide: true });
let buf = '';
const pending = new Map<number, (v: unknown) => void>();
proc.stdout.on('data', (c: Buffer) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const msg = JSON.parse(line) as { id?: number };
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    } catch { /* server chatter */ }
  }
});
let nextId = 1;
const rpc = (method: string, params: unknown) => new Promise<any>((resolve) => {
  const rid = nextId++;
  pending.set(rid, resolve);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
});
const callTool = async (name: string, a: Record<string, unknown>) => {
  const r = await rpc('tools/call', { name, arguments: a });
  return String(r?.result?.content?.[0]?.text ?? JSON.stringify(r));
};

try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  console.log('1 plan a fresh mission :', (await callTool('mission_plan', {
    mission_id: id, steps: [{ title: 'a', instruction: 'x' }, { title: 'b', instruction: 'y' }] })).slice(0, 70));

  await query(`UPDATE mission_steps SET status='succeeded', result='did the thing' WHERE mission_id=$1 AND seq=1`, [id]);

  const replan = await callTool('mission_plan', { mission_id: id, steps: [{ title: 'c', instruction: 'z' }] });
  console.log('2 replan over real work:', replan.slice(0, 100));
  const kept = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM mission_steps WHERE mission_id=$1 AND status='succeeded'`, [id]);
  console.log(`   succeeded steps still present: ${kept?.n}  ${kept?.n === 1 ? 'PASS' : 'FAIL - history was destroyed'}`);

  await query(`UPDATE missions SET status='completed', completed_at=now() WHERE id=$1`, [id]);
  const added = await callTool('mission_add_step', { mission_id: id, title: 'later thought', instruction: 'w' });
  console.log('3 add step to completed:', added.slice(0, 90));
  const st = await one<{ status: string }>(`SELECT status FROM missions WHERE id=$1`, [id]);
  console.log(`   mission status now: ${st?.status}  ${st?.status === 'running' ? 'PASS' : 'FAIL - still completed with pending steps'}`);
} finally {
  proc.kill();
  const d = await query<{ id: string }>(`DELETE FROM missions WHERE slug=$1 RETURNING id`, [SLUG]);
  console.log(`   cleaned ${d.length} mission`);
  await closePool();
}
