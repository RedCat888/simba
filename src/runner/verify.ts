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
  /** What we asked for. */
  model: string | null;
  /** What the CLI says it actually ran, when it says. */
  resolvedModel?: string | null;
  /** True when those two are not the same model. */
  drift?: boolean;
}

/**
 * What the CLI reported running, as opposed to what it was asked for.
 *
 * This exists because aliases lie by omission. Simba's top tier was configured
 * as 'opus', which reads as "the best Opus" and actually resolved to
 * claude-opus-4-7 — so the most capable agent in the system ran a generation
 * behind for weeks while the configuration looked entirely correct. Nothing was
 * wrong enough to notice. 'sonnet' had drifted to claude-sonnet-4-6 the same way.
 *
 * Every one of these CLIs echoes the real model in its JSON output, so the
 * discrepancy is detectable — it simply was not being looked at.
 */
export function reportedModels(out: string): string[] {
  const seen = new Set<string>();

  // Two shapes, because Claude emits different ones depending on config.
  //
  // With the default config it prints an init event carrying "model". With
  // CLAUDE_CONFIG_DIR pointed at an isolated brain directory — which is how
  // every Claude account here actually runs — it prints only a result object,
  // and the init event is gone. Reading just "model" therefore found nothing on
  // precisely the accounts that had the alias problem, so drift detection was
  // blind exactly where it was needed. The model survives in that shape as a
  // *key* under modelUsage.
  for (const m of out.matchAll(/"model"\s*:\s*"([^"]+)"/g)) {
    const v = m[1];
    if (v && v.length < 80) seen.add(v);
  }
  for (const m of out.matchAll(/"modelUsage"\s*:\s*\{\s*"([^"]+)"/g)) {
    const v = m[1];
    if (v && v.length < 80) seen.add(v);
  }

  // All of them, not the first.
  //
  // A turn legitimately touches more than one model: Claude Code runs
  // background work on Haiku alongside the main model, so both land in
  // modelUsage. Picking whichever appeared first reported claude-haiku-4-5 for
  // a session correctly running claude-opus-5 — a false alarm, which in a
  // checker is as damaging as missing the real thing.
  return [...seen];
}

/**
 * Loose comparison. An alias and its target are different strings by
 * definition, so this asks whether the resolved model plausibly *is* the
 * requested one rather than whether the strings match.
 */
export function looksLikeSameModel(asked: string, got: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = norm(asked);
  const g = norm(got);
  if (a === g || g.startsWith(a) || a.startsWith(g)) return true;

  // An alias like "opus" is a substring of the family but carries no version,
  // so a bare family name can never confirm a version — treat it as unknown
  // rather than as agreement.
  const askedVersion = asked.match(/\d+(?:[.-]\d+)?/)?.[0]?.replace('-', '.') ?? null;
  const gotVersion = got.match(/\d+(?:[.-]\d+)?/)?.[0]?.replace('-', '.') ?? null;
  if (!askedVersion || !gotVersion) return false;
  return askedVersion === gotVersion;
}

/** Strips ANSI colour so a verdict reads cleanly. */
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

/**
 * "Say OK", not "Reply with exactly OK".
 *
 * The phrasing matters, which is not obvious and cost an hour to find. Claude
 * Code recognises "reply with exactly …" as a trivial instruction-following
 * pattern and serves it from a cheap path: the same account, same
 * `--model claude-opus-5` flag, reports claude-haiku-4-5 for that wording and
 * claude-opus-5 for "Say OK" or "hi". Verifying with the first phrasing measures
 * the routing shortcut rather than the configured model, and drift detection
 * built on it fires constantly on brains that are perfectly fine.
 *
 * "Say OK" keeps a deterministic answer to test against while still going to the
 * real model.
 */
/**
 * Pulls the human-readable part out of a failure.
 *
 * Taking the last 220 characters is the obvious approach and produces things
 * like `auth/entitlement: ,"x-github-edge-region":"iad","x-github-request-id":…`
 * — the tail of a failure is usually response headers, not the reason. These
 * CLIs all put the reason in a `message` or `responseBody` field somewhere in
 * the middle, so prefer those and fall back to the tail only when neither is
 * present.
 */
export function extractMessage(body: string): string {
  const candidates = [
    ...body.matchAll(/"responseBody"\s*:\s*"((?:[^"\\]|\\.){3,400})"/g),
    ...body.matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.){3,400})"/g),
  ]
    .map((m) => (m[1] ?? '').replace(/\\n/g, ' ').replace(/\\"/g, '"').trim())
    // Skip generic wrappers that restate the status without saying anything.
    .filter((s) => s && !/^(error|failed|request failed)$/i.test(s));

  if (candidates.length > 0) {
    // The innermost message is usually the specific one; the outer layers are
    // the transport restating it.
    return candidates[candidates.length - 1]!.slice(0, 220);
  }
  return body.slice(-220);
}

const PROMPT = 'Say OK';

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
  // Status codes need word boundaries. Without them "403" matched inside a
  // request UUID — `18611643-764a-4033-...` — and a cursor turn that returned
  // "result":"OK" with is_error:false was reported as an entitlement failure.
  // A verifier that invents auth problems is worse than none, because the whole
  // point of it is to correct a wrong stored status.
  const authFailure = /not logged in|unauthor|forbidden|not licensed|\b40[13]\b/i.test(body);
  const limited = /rate limit|quota|usage limit|\b429\b/i.test(body);

  if (answered && !authFailure) {
    // Drift is "the model I asked for never appears in what the CLI reported
    // using" — not "the first model reported differs". The weaker question
    // false-alarms on every Claude turn, since background work runs on Haiku.
    const reported = reportedModels(r.out);
    const matched = model ? reported.find((got) => looksLikeSameModel(model, got)) : undefined;
    const drift = Boolean(model && reported.length > 0 && !matched);
    const resolved = matched ?? reported[0] ?? null;

    // Answering is not the same as answering on the model you configured, and
    // the difference is exactly what hid Opus 4.7 behind the 'opus' alias. A
    // drifting brain is still usable, so this stays ok:true — but it says so.
    return {
      ok: true,
      detail: drift
        ? `answered in ${r.ms}ms, but reported using ${reported.map((m) => `"${m}"`).join(', ')} ` +
          `— never the configured "${model}". Pin an explicit id; aliases drift silently.`
        : `answered in ${r.ms}ms on ${resolved ?? model ?? 'default model'}`,
      ms: r.ms,
      model,
      resolvedModel: resolved,
      drift,
    };
  }

  const detail = authFailure
    ? `auth/entitlement: ${extractMessage(body)}`
    : limited
      ? `rate limited: ${extractMessage(body)}`
      : `no answer (exit ${r.code}): ${extractMessage(body)}`;

  return { ok: false, detail, ms: r.ms, model };
}
