import { resolveExecutor, buildSpawn } from '../src/runner/discovery.js';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

/**
 * Which brains actually answer right now?
 *
 * The brain_accounts table records a status, but a status is a claim about the
 * past — it is written when something last happened to change it. "Is codex
 * working" can only be answered by asking codex. Each CLI gets one real turn
 * with a trivial prompt; anything that comes back is proof, anything that does
 * not is the actual error text rather than a remembered one.
 */

async function run(
  bin: { path: string; prefixArgs: string[] },
  args: string[],
  timeoutMs = 120_000,
): Promise<{ ok: boolean; out: string; ms: number }> {
  const started = Date.now();
  // A .cmd shim cannot be spawned directly on Windows — it is not an
  // executable image, and Node reports EINVAL. buildSpawn wraps those through
  // cmd.exe, which is the same path the real runners take.
  const invocation = buildSpawn(bin.path, [...bin.prefixArgs, ...args]);
  return new Promise((resolve) => {
    const proc = spawn(invocation.command, invocation.args, {
      cwd: tmpdir(),
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let out = '';
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, out: `${out}\n[timed out]`, ms: Date.now() - started });
    }, timeoutMs);

    // Every one of these blocks on stdin without a terminal.
    try {
      proc.stdin.end();
    } catch {
      /* already closed */
    }
    proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
    proc.stderr.on('data', (c: Buffer) => (out += c.toString()));
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out: e.message, ms: Date.now() - started });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, ms: Date.now() - started });
    });
  });
}

function clean(s: string): string {
  // Strip ANSI so the verdict is readable.
  return s.replace(/\[[0-9;]*[A-Za-z]/g, '').replace(/\s+/g, ' ').trim();
}

for (const cli of ['codex', 'cursor-agent', 'opencode'] as const) {
  const bin = await resolveExecutor(cli);
  if (!bin) {
    console.log(`${cli.padEnd(14)} NOT INSTALLED`);
    continue;
  }

  const args =
    cli === 'codex'
      ? ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', 'Reply with exactly OK']
      : cli === 'cursor-agent'
        ? ['-p', 'Reply with exactly OK', '--output-format', 'text']
        : ['run', '--pure', '-m', 'opencode/big-pickle', 'Reply with exactly OK'];

  const r = await run(bin, args);
  const body = clean(r.out).slice(-260);
  console.log(`${cli.padEnd(14)} ${r.ok ? 'OK  ' : 'FAIL'} ${String(r.ms).padStart(6)}ms  ${body}`);
  console.log(`${''.padEnd(14)} bin: ${bin.path}`);
}

process.exit(0);
