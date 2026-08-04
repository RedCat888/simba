import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * OpenCode as a free model provider.
 *
 * OpenCode aggregates provider credentials and exposes a genuinely free tier
 * ("OpenCode Zen"). That matters because Simba's cheap path â€” titling,
 * summarizing, checkpoint authoring, decision extraction â€” is high volume and
 * low stakes, and paying subscription headroom for it is what makes a $20 plan
 * run out early. Local Ollama covers this too, but at ~16 tok/s on this GPU,
 * and it competes for the same RAM as everything else on the machine.
 *
 * Not every advertised free model works. `minimax-m2.5-free` and `gpt-5-nano`
 * both returned server errors on probing; `big-pickle` responded normally, so
 * that is the default. The model is configurable precisely because free-tier
 * availability moves around.
 */

const BIN_CANDIDATES = [
  process.env.SIMBA_OPENCODE_BIN ?? '',
  join(homedir(), 'scoop', 'shims', 'opencode.exe'),
  join(homedir(), 'AppData', 'Local', 'opencode', 'opencode-cli.exe'),
];

let cachedBin: string | null | undefined;

function findBin(): string | null {
  if (cachedBin !== undefined) return cachedBin;
  cachedBin = BIN_CANDIDATES.find((p) => p && existsSync(p)) ?? null;
  return cachedBin;
}

export const OPENCODE_FREE_MODEL = process.env.SIMBA_OPENCODE_MODEL ?? 'opencode/big-pickle';

/**
 * Extracts assistant text from OpenCode's JSON event stream.
 *
 * Events are `step_start` / `text` / `step_finish`, each with the payload under
 * `part`. Only the text parts carry content; concatenating them in order
 * reconstructs the reply.
 */
function extractText(stdout: string): string | null {
  const chunks: string[] = [];
  let sawError: string | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (ev.type === 'error') {
      const e = ev.error as { data?: { message?: string } } | undefined;
      sawError = e?.data?.message ?? 'opencode error';
      continue;
    }
    if (ev.type !== 'text') continue;

    const part = ev.part as Record<string, unknown> | undefined;
    const text = part?.text ?? part?.content;
    if (typeof text === 'string' && text) chunks.push(text);
  }

  if (sawError && chunks.length === 0) {
    console.error('[opencode]', sawError);
    return null;
  }
  const joined = chunks.join('').trim();
  return joined.length > 0 ? joined : null;
}

export async function opencodeComplete(
  prompt: string,
  timeoutMs = 120_000,
  model = OPENCODE_FREE_MODEL,
): Promise<string | null> {
  const bin = findBin();
  if (!bin) return null;

  try {
    // spawn, not execFile, specifically so stdin can be closed.
    //
    // opencode waits on stdin when it has no terminal attached, so an execFile
    // call just hangs until the timeout â€” which presents as "exit null, empty
    // stdout, empty stderr" and reads like the free tier being down rather than
    // the process never having started work. Identical to the Codex adapter.
    const stdout = await new Promise<string>((resolve, reject) => {
      const proc = spawn(
        bin,
        ['run', '--format', 'json', '--pure', '-m', model, prompt],
        {
          windowsHide: true,
          // opencode treats cwd as a project root and indexes it, so point it
          // somewhere neutral rather than at whatever the caller happened to be in.
          cwd: homedir(),
        },
      );

      let out = '';
      let errOut = '';
      const timer = setTimeout(() => {
        proc.kill();
        reject(Object.assign(new Error('opencode timed out'), { stdout: out, stderr: errOut }));
      }, timeoutMs);

      try {
        proc.stdin.end();
      } catch {
        /* already closed */
      }

      proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
      proc.stderr.on('data', (c: Buffer) => (errOut += c.toString()));
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        // Non-zero exit is not necessarily failure here: the event stream is
        // already on stdout, so let the parser decide.
        if (out.includes('"type"')) resolve(out);
        else reject(Object.assign(new Error(`opencode exit ${code}`), { stdout: out, stderr: errOut }));
      });
    });

    return extractText(stdout);
  } catch (err) {
    // execFile throws on a non-zero exit, but opencode still writes its event
    // stream to stdout first â€” so parse before giving up.
    const out = (err as { stdout?: string }).stdout;
    if (typeof out === 'string' && out.includes('"type"')) {
      const salvaged = extractText(out);
      if (salvaged) return salvaged;
    }
    // Free capacity is intermittently unavailable â€” probing found two of four
    // advertised models returning server errors, and even a working one fails
    // occasionally. That is the nature of a free tier, not an incident, so this
    // is a debug-level note and the caller falls through to the next provider.
    if (process.env.SIMBA_DEBUG) {
      const e = err as { code?: number; stderr?: string; stdout?: string };
      console.error(
        '[opencode] free tier unavailable â€” exit',
        e.code,
        '| stderr:',
        (e.stderr ?? '').slice(0, 300).replace(/\s+/g, ' '),
        '| stdout:',
        (e.stdout ?? '').slice(0, 300).replace(/\s+/g, ' '),
      );
    }
    return null;
  }
}

/** True when opencode is installed and its free model answers. */
export async function opencodeAvailable(): Promise<boolean> {
  if (!findBin()) return false;
  const r = await opencodeComplete('Reply with OK', 45_000);
  return r !== null;
}

