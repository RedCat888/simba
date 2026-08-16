import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Hearing and speaking, locally.
 *
 * The vision the operator stated on 7 August names exactly one missing piece, twice:
 * a local voice layer. "Speak a command, it routes to the right capability, the
 * answer comes back aloud" — and specifically from the phone, not only from a
 * desktop push-to-talk key.
 *
 * Nothing here is new infrastructure, which is why it was worth doing first:
 *
 *   **STT** is faster-whisper, already installed in ReelAgent's virtualenv and
 *   already transcribing the audio of every reel that comes in. The model is
 *   downloaded, the venv works, and it has been running in production for
 *   weeks — so the honest move is to call it rather than install a second one.
 *
 *   **TTS** is the speech synthesiser built into Windows. Two voices, no
 *   install, no key, no network. Piper and Kokoro sound better and can replace
 *   this behind the same two functions, but neither is here today and the
 *   difference between "sounds good" and "exists" is the whole feature.
 *
 * Audio never leaves the machine in either direction, which is the point of
 * doing it locally rather than the side effect.
 */

const REEL_VENV = 'C:\\Users\\operator\\ReelAgent\\.venv\\Scripts\\python.exe';

/** Whisper model size. `small` is what the reel pipeline already downloaded. */
const MODEL = process.env.SIMBA_WHISPER_MODEL ?? 'small';

export interface Heard {
  text: string;
  seconds: number;
  language: string | null;
}

/** Is the local voice stack actually usable, and if not, why? */
export function voiceAvailable(): { stt: boolean; tts: boolean; reason: string | null } {
  const stt = existsSync(REEL_VENV);
  // SAPI is present on every Windows install; the check is for the platform.
  const tts = process.platform === 'win32';
  return {
    stt,
    tts,
    reason: stt
      ? null
      : `speech-to-text needs ReelAgent's virtualenv at ${REEL_VENV} — it holds faster-whisper`,
  };
}

/**
 * Audio in, words out.
 *
 * Takes the bytes the phone recorded rather than a path, because the caller is
 * an HTTP handler and writing the upload to disk is this function's problem,
 * not the route's.
 */
export async function transcribe(audio: Buffer, ext = 'm4a'): Promise<Heard> {
  const dir = await mkdtemp(join(tmpdir(), 'simba-voice-'));
  const src = join(dir, `clip.${ext}`);
  try {
    await writeFile(src, audio);

    // Run through the venv's python rather than importing anything into node:
    // faster-whisper is a Python library and this is the interpreter that
    // already has it, its model cache, and its CUDA/CPU choice settled.
    // Reuses ReelAgent's transcriber module rather than reimplementing it.
    //
    // The first version here loaded WhisperModel(device="auto"), which this
    // installed version rejects — and the working code next door has never used
    // "auto". It tries CUDA for the 3070, falls back to CPU when the runtime is
    // missing, and falls back *again* if the GPU only fails at transcribe time,
    // which is a real failure mode it learned the hard way. Writing a second,
    // naiver loader beside it would mean maintaining two and trusting the worse.
    const script = `
import json, sys
sys.path.insert(0, r"C:\\Users\\operator\\ReelAgent\\bot")
from transcriber import transcribe
text = transcribe(sys.argv[1])
print("@@" + json.dumps({"text": text}))
`.trim();
    const scriptPath = join(dir, 'stt.py');
    await writeFile(scriptPath, script, 'utf8');

    const { stdout } = await run(REEL_VENV, [scriptPath, src], {
      // A long clip on CPU is genuinely slow; the phone is holding a spinner,
      // not blocking a person's typing.
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    // Marked with a sentinel rather than "take the last line": the model loader
    // logs to stdout on a cold start, and a warning arriving after the result
    // would otherwise be parsed as the result.
    const line = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('@@')).pop();
    if (!line) throw new Error(`no transcript in output: ${stdout.slice(-300)}`);
    const parsed = JSON.parse(line.slice(2)) as { text?: string };
    return { text: parsed.text ?? '', seconds: 0, language: null };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Words in, a wav out.
 *
 * Returns bytes rather than playing them, because the thing that should make
 * the sound is whichever surface asked — the phone's speaker when you are away
 * from the desk, this machine's when you are at it.
 */
export async function speak(text: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'simba-tts-'));
  const out = join(dir, 'speech.wav');
  try {
    // Base64 through the argument, so nothing in the text can end the string
    // and become PowerShell. Spoken text is model output, and model output is
    // exactly the input you should not be pasting into a shell.
    const encoded = Buffer.from(text.slice(0, 4000), 'utf8').toString('base64');
    const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SetOutputToWaveFile('${out.replace(/\\/g, '\\\\')}')
$s.Rate = 1
$s.Speak($text)
$s.Dispose()
`.trim();
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      timeout: 60_000,
      windowsHide: true,
    });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * What a spoken sentence should be turned into.
 *
 * Voice is not a text box you talk at. "What needs me" is a question this
 * system can answer instantly from its own tables, and routing that to an agent
 * would spend a model call and thirty seconds to read out a number it already
 * knows. So the common phrasings are matched here and answered directly; only
 * what is left over becomes a session.
 *
 * Deliberately a short list of things people actually say, not a grammar. It
 * grows when a real utterance misses.
 */
export type Intent =
  | { kind: 'status' }
  | { kind: 'needs_me' }
  | { kind: 'capture'; text: string }
  | { kind: 'ask'; text: string };

export function classify(said: string): Intent {
  const s = said.trim().toLowerCase().replace(/[.?!]+$/, '');
  if (!s) return { kind: 'ask', text: said };

  if (/^(status|system status|how are (we|things)|what.?s (the )?status|sitrep)$/.test(s)) {
    return { kind: 'status' };
  }
  if (/(what|anything).*(need|waiting|blocked|approv)/.test(s) || /^what needs me$/.test(s)) {
    return { kind: 'needs_me' };
  }
  // "remember that…", "note that…", "capture…" — the thing you say when you do
  // not want an answer, you want it written down.
  const capture = s.match(/^(remember|note|capture|save|jot down)\b[:,]?\s*(that\s+)?(.+)$/);
  if (capture) return { kind: 'capture', text: said.replace(/^\s*\w+\b[:,]?\s*(that\s+)?/i, '') };

  return { kind: 'ask', text: said };
}
