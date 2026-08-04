import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

import { one } from '../db/index.js';
import { config } from '../config.js';
import { resolveExecutor, buildSpawn } from './discovery.js';

/**
 * Ask a brain whether it works, right now.
 *
 * Written because two working subscriptions sat benched for days behind a stale
 * status. Cursor was recorded as logged_out when it was logged in and fine — the
 * real fault was that Simba had it configured for model ids that did not exist
 * in its catalog, so every request was refused and the refusal was filed as an
 * entitlement problem. A status is only a claim about whenever something last
 * changed it, and nothing was re-asking the question.
 *
 * So this asks. One trivial turn per CLI, using the brain's own configured
 * model, because a brain that answers on some other model is not the thing
 * being tested — the configured id is exactly what was wrong last time.
 */

export interface VerifyResult {
  ok: boolean;
  detail: string;
  ms: number;
  model: string | null;
}

function clean(s: string): string {
  return s
    .replace(/\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function runOnce(
  bin: { path: string; prefixArgs: string[] },
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; out: string; ms: number }> {
  const started = Date.now();
  // A .cmd shim is not an executable image; spawning it directly gives EINVAL.
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
      resolve({ code: null, out: `${out}\n[timed out after ${timeoutMs}ms]`, ms: Date.now() - started });
    }, timeoutMs);

    // Every one of these CLIs blocks on stdin with no terminal attached.
    try {
      proc.stdin.end();
    } catch {
      /* already closed */
    }

    proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
    proc.stderr.on('data', (c: Buffer) => (out += c.toString()));
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: e.message, ms: Date.now() - started });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, ms: Date.now() - started });
    });
  });
}

const PROMPT = 'Reply with exactly OK';

export async function verifyBrain(slug: string, timeoutMs = 120_000): Promise<VerifyResult> {
  const brain = await one<{
    cli: string;
    config_dir: string | null;
    tier_models: Record<string, string> | null;
  }>(`SELECT cli, config_dir, tier_models FROM brain_accounts WHERE slug = $1`, [slug]);

  if (!brain) return { ok: false, detail: 'no such brain', ms: 0, model: null };

  // The configured id, not a convenient one. A brain that answers on some other
  // model tells you nothing about whether this account is usable as configured.
  const model = brain.tier_models?.high ?? brain.tier_models?.mid ?? brain.tier_models?.cheap ?? null;

  if (brain.cli === 'ollama') {
    const started = Date.now();
    try {
      const res = await fetch(`${config.embedding.endpoint}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      return {
        ok: res.ok,
        detail: res.ok ? 'local server responding' : `HTTP ${res.status}`,
        ms: Date.now() - started,
        model,
      };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : 'unreachable',
        ms: Date.now() - started,
        model,
      };
    }
  }

  const bin = await resolveExecutor(brain.cli);
  if (!bin) return { ok: false, detail: `${brain.cli} is not installed`, ms: 0, model };

  let args: string[];
  switch (brain.cli) {
    case 'claude':
      args = ['-p', PROMPT, '--output-format', 'json', '--strict-mcp-config'];
      if (model) args.push('--model', model);
      break;
    case 'codex':
      args = ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
      if (model) args.push('-m', model);
      args.push(PROMPT);
      break;
    case 'cursor-agent':
      // --force accepts the directory-trust prompt. Without it the CLI stops and
      // asks, which from a headless caller looks exactly like a hang.
      args = ['--print', '--output-format', 'stream-json', '--force'];
      if (model) args.push('--model', model);
      args.push(PROMPT);
      break;
    case 'opencode':
      args = ['run', '--format', 'json', '--pure'];
      if (model) args.push('-m', model);
      args.push(PROMPT);
      break;
    default:
      return { ok: false, detail: `no verification defined for ${brain.cli}`, ms: 0, model };
  }

  const env = brain.config_dir
    ? brain.cli === 'claude'
      ? { CLAUDE_CONFIG_DIR: brain.config_dir }
      : { CODEX_HOME: brain.config_dir }
    : {};
  Object.assign(process.env, env);

  const r = await runOnce(bin, args, timeoutMs);
  const body = clean(r.out);

  // Exit code alone is not the signal. Codex prints MCP handshake warnings and
  // still exits 0; cursor exits non-zero on a trust prompt it never got past.
  // The question is whether a real answer came back.
  const answered = /\bOK\b/i.test(body);
  const authFailure = /not logged in|unauthor|forbidden|not licensed|401|403/i.test(body);
  const limited = /rate limit|quota|usage limit|429/i.test(body);

  if (answered && !authFailure) {
    return { ok: true, detail: `answered in ${r.ms}ms on ${model ?? 'default model'}`, ms: r.ms, model };
  }

  const detail = authFailure
    ? `auth/entitlement: ${body.slice(-220)}`
    : limited
      ? `rate limited: ${body.slice(-220)}`
      : `no answer (exit ${r.code}): ${body.slice(-220)}`;

  return { ok: false, detail, ms: r.ms, model };
}
