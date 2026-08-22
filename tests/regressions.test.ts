import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { denyRulesFor } from '../src/runner/opencode.js';
import { denyNotice } from '../src/runner/boundary.js';
import { describeExit } from '../src/session/engine.js';
import {
  looksLikeSameModel,
  reportedModels,
  extractMessage,
  classifyFailure,
} from '../src/runner/verify.js';
import { hostAllowed, originAllowed, channelOf } from '../src/policy/identity.js';
import { settledVerifyResults } from '../src/runner/verify.js';
import { samePath } from '../src/session/worktree.js';
import { maskSecrets } from '../src/inventory/files.js';
import { parseSchedule } from '../src/missions/schedule.js';
import { tickDecision } from '../src/supervisor/tick-guard.js';
import { classify } from '../src/voice/index.js';
import { chunkText } from '../src/ingest/chunk.js';
import { pressureLevel } from '../src/ops/commit-charge.js';
import { surfaceForPrincipal, describePrincipal } from '../src/policy/access.js';
import { config } from '../src/config.js';
import {
  isAuthFailureMessage,
  mergeBrainChains,
  nextBrainInChain,
  parseUsageResetAt,
  isFloorBrainSlug,
  isRateLimitedMessage,
} from '../src/policy/brains.js';

/**
 * Regressions for bugs that actually shipped.
 *
 * Every case here is something that was wrong in this repository and was found
 * either by an external audit or by chasing a symptom — not a hypothetical. The
 * reason this file exists at all is that all of it had been verified once, by
 * hand, and nothing stopped any of it from silently coming back.
 *
 * The shared shape is worth stating: almost none of these failed loudly. They
 * returned null, or reported a healthy status, or produced a config that
 * validated and was never consulted. A system whose native failure mode is
 * "returned nothing" needs tests that assert on the *content* of a result, not
 * merely that a call did not throw.
 */

describe('deny list translation', () => {
  const rules = denyRulesFor([]);

  test('emits the command name, not a regex fragment', () => {
    // Auto-translating the profile regexes produced `*bdiskpart*` — the \b
    // word-boundary escape leaving a stray b glued to every token — so no rule
    // ever matched anything and the boundary was silently absent.
    assert.equal(rules['*diskpart*'], 'deny');
    assert.equal(rules['*bdiskpart*'], undefined, 'stray \\b prefix is back');
  });

  test('covers disk, boot, backup and service destruction', () => {
    for (const cmd of ['diskpart', 'format', 'bcdedit', 'vssadmin', 'wbadmin', 'sc delete']) {
      assert.equal(rules[`*${cmd}*`], 'deny', `${cmd} is not denied`);
    }
  });

  test('does not blanket-deny ordinary Windows commands', () => {
    // The same broken translation emitted `*.exe*` and `*delete*`, which between
    // them would have refused most commands on this machine — a deny list that
    // blocks everything trains its reader to ignore it.
    assert.equal(rules['*.exe*'], undefined);
    assert.equal(rules['*delete*'], undefined);
    assert.equal(rules['*'], 'allow', 'unlisted commands must stay permitted');
  });

  test('registry rules need a verb and a machine-wide hive', () => {
    assert.equal(rules['*reg*delete*HKLM*'], 'deny');
    // `reg query` is how an agent finds out what is installed.
    assert.equal(rules['*reg*'], undefined, 'reads must not be denied');
  });
});

describe('stated boundary', () => {
  test('is empty when there is no profile to state', () => {
    assert.equal(denyNotice([]), '');
  });

  test('names the operations and permits reads', () => {
    const notice = denyNotice(['(?i)\\bdiskpart\\b']);
    for (const word of ['diskpart', 'bcdedit', 'HKLM', 'rm -rf /']) {
      assert.ok(notice.includes(word), `boundary does not mention ${word}`);
    }
    assert.ok(/reg query/.test(notice), 'boundary must allow reads explicitly');
  });
});

describe('process exit decoding', () => {
  test('decodes the NTSTATUS codes this system has produced', () => {
    // The audit log carried `code=3221226505`, which is complete and useless.
    assert.match(describeExit(3221226505, null), /stack buffer overrun|crashed/);
    assert.match(describeExit(2147483651, null), /breakpoint|assertion/);
    assert.match(describeExit(4294967295, null), /-1/);
  });

  test('distinguishes clean exit, signal and no code', () => {
    assert.match(describeExit(0, null), /cleanly/);
    assert.match(describeExit(null, 'SIGKILL'), /SIGKILL/);
    assert.match(describeExit(null, null), /without an exit code/);
  });
});

describe('model drift detection', () => {
  test('an alias is not evidence of a version', () => {
    // Tier 0 ran on `opus`, which resolves to claude-opus-4-7. A bare family
    // name must never be treated as confirming the version asked for.
    assert.equal(looksLikeSameModel('claude-opus-5', 'claude-opus-4-7'), false);
    assert.equal(looksLikeSameModel('claude-opus-5', 'claude-opus-5'), true);
  });

  test('accepts a display name for the same model', () => {
    // Cursor reports "Opus 5 1M Thinking" for claude-opus-5-thinking-high.
    assert.equal(looksLikeSameModel('claude-opus-5-thinking-high', 'Opus 5 1M Thinking'), true);
  });

  test('finds the model in both shapes Claude emits', () => {
    // With CLAUDE_CONFIG_DIR set there is no init event at all, and the model
    // survives only as a key under modelUsage — which is precisely the setup
    // every Claude account here uses, so reading "model" alone was blind where
    // it mattered.
    assert.deepEqual(reportedModels('{"model":"claude-opus-5"}'), ['claude-opus-5']);
    assert.deepEqual(
      reportedModels('{"modelUsage":{"claude-opus-5":{"inputTokens":2}}}'),
      ['claude-opus-5'],
    );
  });

  test('returns every model a turn touched', () => {
    // Claude runs background work on Haiku alongside the main model. Taking the
    // first reported one flagged healthy sessions as drifting.
    const out = '{"modelUsage":{"claude-haiku-4-5":{},"claude-opus-5":{}}}"model":"claude-opus-5"';
    const models = reportedModels(out);
    assert.ok(models.includes('claude-opus-5'));
    assert.ok(models.length > 1, 'must not collapse to a single model');
  });
});

describe('failure message extraction', () => {
  test('prefers the reason over response headers', () => {
    const body =
      '{"error":{"responseBody":"unauthorized: not licensed to use Copilot",' +
      '"headers":{"x-github-request-id":"F6D3:519B1"}}}';
    const msg = extractMessage(body);
    assert.match(msg, /not licensed/);
    assert.doesNotMatch(msg, /x-github-request-id/);
  });
});

describe('local channel trust', () => {
  test('a literal IP cannot be DNS-rebound, so it is allowed', () => {
    // The emulator reaches the host as 10.0.2.2; allow-listing two spellings of
    // loopback rejected every legitimate non-loopback client.
    assert.equal(hostAllowed('local', '10.0.2.2:8787'), true);
    assert.equal(hostAllowed('local', '127.0.0.1'), true);
    assert.equal(hostAllowed('local', 'localhost:8787'), true);
  });

  test('a foreign name is refused', () => {
    // Rebinding needs a name; that is the entire attack.
    assert.equal(hostAllowed('local', 'evil.example.com'), false);
    assert.equal(hostAllowed('local', undefined), false);
  });

  test('a browser origin from elsewhere is refused on the local channel', () => {
    assert.equal(originAllowed('local', 'https://evil.example.com'), false);
    assert.equal(originAllowed('local', undefined), true, 'native clients send no Origin');
    assert.equal(originAllowed('local', 'file://'), true, 'the desktop app loads UI from disk');
  });

  test('channel comes from the listening port, which a client cannot set', () => {
    assert.equal(channelOf(8787), 'local');
    assert.equal(channelOf(8788), 'tunnel');
  });
});

describe('natural-language schedules', () => {
  test('understands the phrasings people actually use', () => {
    // Requiring cron syntax is what stops recurring work being scheduled at all.
    assert.equal(parseSchedule('every morning')?.cron, '0 7 * * *');
    assert.equal(parseSchedule('every 30 minutes')?.cron, '*/30 * * * *');
    assert.equal(parseSchedule('weekdays at 9')?.cron, '0 9 * * 1-5');
    assert.equal(parseSchedule('every friday at 18:00')?.cron, '0 18 * * 5');
    assert.equal(parseSchedule('daily at 6am')?.cron, '0 6 * * *');
  });

  test('passes an explicit cron expression through', () => {
    assert.equal(parseSchedule('0 7 * * *')?.cron, '0 7 * * *');
  });

  test('refuses what it does not understand rather than guessing', () => {
    // A schedule that silently means something else is worse than none: it
    // would fire at an hour nobody chose, forever.
    assert.equal(parseSchedule('sometimes'), null);
    assert.equal(parseSchedule('when the build is green'), null);
    assert.equal(parseSchedule(''), null);
  });

  test('reads the schedule back so a misparse is visible', () => {
    assert.match(String(parseSchedule('every morning')?.describes), /07:00/);
  });
});

describe('why a brain said no', () => {
  // claude-a was verified on 4 August while rate limited, recorded as 'error',
  // and was still benched two days later — because clearExpiredLimits only
  // revives accounts marked 'limited', and nothing else ever revisits 'error'.
  // Simba ran on one Claude account for two days with a second one healthy.
  test('a rate limit is limited, not broken', () => {
    assert.equal(classifyFailure('Claude AI usage limit reached'), 'limited');
    assert.equal(classifyFailure('API Error: 429 Too Many Requests'), 'limited');
    assert.equal(classifyFailure('you have exceeded your quota'), 'limited');
    assert.equal(classifyFailure('rate limit exceeded, try again later'), 'limited');
  });

  test('auth problems stay broken, because they need a person', () => {
    assert.equal(classifyFailure('Invalid API key · Not logged in'), 'auth');
    assert.equal(classifyFailure('403 Forbidden'), 'auth');
    assert.equal(classifyFailure('GitHub Copilot: not licensed'), 'auth');
    assert.equal(classifyFailure('OAuth session expired and could not be refreshed'), 'auth');
  });

  // Both signals in one body. Retrying forever against an account that will
  // never work is worse than waiting for a human who can fix it.
  test('auth wins when a body carries both signals', () => {
    assert.equal(
      classifyFailure('401 Unauthorized: your plan has no quota for this model'),
      'auth',
    );
  });

  test('anything else is unresponsive', () => {
    assert.equal(classifyFailure('spawn ENOENT'), 'unresponsive');
    assert.equal(classifyFailure(''), 'unresponsive');
    assert.equal(classifyFailure('exit code 1'), 'unresponsive');
  });
});

describe('worktree path identity', () => {
  // git answers --show-toplevel in forward slashes on every platform, so on
  // Windows the reply never string-matches the path it was given. Getting this
  // wrong fails dangerously: every real worktree would look like a stale empty
  // directory and its uncollected work would be reported as nothing to collect.
  test('matches across separator and case differences', () => {
    assert.equal(
      samePath('C:/workspace/simba/var/worktrees/a', 'C:\\Users\\operator\\simba\\var\\worktrees\\a'),
      true,
    );
    assert.equal(samePath('C:/example-workspace/Simba', 'c:/users/operator/simba'), true);
    assert.equal(samePath('C:/workspace/simba/', 'C:/workspace/simba'), true);
  });

  // The case that mattered: an empty leftover directory makes git walk up to
  // the parent repository, so the parent's toplevel comes back instead. Those
  // are different places and must not compare equal.
  test('a parent repository is not the worktree', () => {
    assert.equal(
      samePath('C:/workspace/simba', 'C:/workspace/simba/var/worktrees/mobile-app-19ca077f'),
      false,
    );
  });
});

describe('file browsing masks secrets by content, not by filename', () => {
  // The intuitive design is a deny list of .env and *.pem. It fails in the
  // direction that matters, and this repository has the proof: its own scanner
  // exists because a live Discord bot token was found in six ordinary-looking
  // config files. Filenames do not predict secrets.
  test('masks a key in a file no deny list would have covered', () => {
    const src = 'const client = new OpenAI({ apiKey: "sk-' + 'a'.repeat(40) + '" });';
    const { text, masked } = maskSecrets(src);
    assert.equal(masked, 1);
    assert.doesNotMatch(text, /sk-a{40}/, 'the key survived masking');
    assert.match(text, /redacted/);
  });

  test('never leaks a prefix of the value it masked', () => {
    // A mask that shows the first characters has narrowed the key for whoever
    // is reading over your shoulder, which is most of the value of hiding it.
    const token = 'ghp_' + 'B'.repeat(36);
    const { text } = maskSecrets(`GITHUB_TOKEN=${token}`);
    assert.doesNotMatch(text, /ghp_B/);
    assert.match(text, /GitHub token redacted, \d+ chars/);
  });

  test('masks every occurrence, not just the first', () => {
    // The source patterns are not global; a file with two keys must not keep
    // the second one.
    const a = 'AKIA' + 'C'.repeat(16);
    const b = 'AKIA' + 'D'.repeat(16);
    const { text, masked } = maskSecrets(`one=${a}\ntwo=${b}`);
    assert.equal(masked, 2);
    assert.doesNotMatch(text, /AKIAC|AKIAD/);
  });

  test('leaves ordinary source untouched', () => {
    // A masker that fires on ordinary code makes every file unreadable, which
    // is its own kind of broken.
    const src = 'export function add(a: number, b: number) { return a + b }';
    const { text, masked } = maskSecrets(src);
    assert.equal(masked, 0);
    assert.equal(text, src);
  });
});

describe('env assignments, the shape the quoted pattern missed', () => {
  // Found by pointing the new file browser at ReelAgent/.env and getting the
  // Instagram password, the session id and the intake token back in the clear,
  // masked count zero. The quoted-assignment pattern fits source code and
  // misses the entire syntax of a .env file, and the scanner reads .env files
  // too — so it had been blind to exactly this.
  test('masks the values that were served in the clear', () => {
    const env = [
      'IG_BOT_PASSWORD=hunter2hunter2',
      'IG_SESSIONID=' + '9'.repeat(60),
      'INTAKE_TOKEN=' + 'f'.repeat(32),
    ].join('\n');
    const { text, masked } = maskSecrets(env);
    assert.equal(masked, 3);
    assert.doesNotMatch(text, /hunter2/);
    assert.doesNotMatch(text, /9{20}/);
    assert.doesNotMatch(text, /f{20}/);
  });

  test('keeps the name so the file still reads as a file', () => {
    // Hiding the whole line would make a config unreadable, which is a
    // different way of hiding things rather than a safer one.
    const { text } = maskSecrets('INTAKE_TOKEN=' + 'a'.repeat(32));
    assert.match(text, /^INTAKE_TOKEN=/);
    assert.match(text, /redacted, 32 chars/);
  });

  test('leaves ports, urls and usernames alone', () => {
    // Keyed on the name, not the shape of the value: a password and a port
    // number look identical, and only the name says which is which.
    const env = 'INTAKE_PORT=4877\nSIMBA_URL=http://127.0.0.1:8787\nIG_BOT_USERNAME=sample-account';
    const { text, masked } = maskSecrets(env);
    assert.equal(masked, 0, 'a masker that fires on every config line makes it unreadable');
    assert.equal(text, env);
  });
});

describe('brain failover classification', () => {
  test('treats OAuth expiry as an auth failure, not a mysterious crash', () => {
    // The claude-a hop this morning died with "OAuth Expired". The old regex
    // only matched "not logged in" / "/login" / "unauthor", so the chain never
    // advanced to Cursor or Codex.
    assert.equal(isAuthFailureMessage('OAuth Expired'), true);
    assert.equal(isAuthFailureMessage('OAuth token expired'), true);
    assert.equal(isAuthFailureMessage('Please run /login to continue'), true);
    assert.equal(isAuthFailureMessage('not logged in'), true);
    assert.equal(isAuthFailureMessage('authentication_error: invalid token'), true);
  });

  test('does not treat ordinary model errors as logout', () => {
    assert.equal(isAuthFailureMessage('rate limit exceeded'), false);
    assert.equal(isAuthFailureMessage('tool timed out'), false);
  });

  test('Cursor team usage is a limit with a calendar reset, not a logout', () => {
    const cursor =
      'The team has reached its usage limit. Please return on 8/22/2026 or reach out to an admin to enable on-demand usage.';
    assert.equal(classifyFailure(cursor), 'limited');
    assert.equal(isRateLimitedMessage(cursor), true);
    assert.equal(parseUsageResetAt(cursor)?.toISOString(), '2026-08-22T00:00:00.000Z');
  });

  test('a 403 that is also a usage cap is limited, not logged out', () => {
    assert.equal(
      classifyFailure('403: team usage limit reached, return on 8/22/2026'),
      'limited',
    );
  });

  test('Claude five-hour windows keep their ISO reset', () => {
    const msg = 'Claude AI usage limit reached · resets 2026-08-19T19:10:00.000Z';
    assert.equal(classifyFailure(msg), 'limited');
    assert.equal(parseUsageResetAt(msg)?.toISOString(), '2026-08-19T19:10:00.000Z');
  });

  test('OpenCode and Ollama are the floor, not paid rungs', () => {
    assert.equal(isFloorBrainSlug('opencode'), true);
    assert.equal(isFloorBrainSlug('ollama'), true);
    assert.equal(isFloorBrainSlug('cursor'), false);
    assert.equal(isFloorBrainSlug('claude-a'), false);
  });

  test('appends policy rungs the agent chain omitted', () => {
    const agent = ['claude-a', 'claude-b', 'codex'];
    const policy = ['claude-b', 'claude-a', 'cursor', 'codex'];
    assert.deepEqual(mergeBrainChains(agent, policy), [
      'claude-a',
      'claude-b',
      'codex',
      'cursor',
    ]);
  });

  test('skips the current brain and keeps declared order', () => {
    const chain = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    assert.equal(nextBrainInChain(chain, 'a')?.id, 'b');
    assert.equal(nextBrainInChain(chain, 'c')?.id, 'a');
  });
});

describe('the supervisor guard that became a permanent stop', () => {
  const WEDGE = 8 * 60_000;

  test('an idle supervisor runs', () => {
    assert.equal(tickDecision(false, 0, 1_000_000, WEDGE), 'run');
  });

  test('a tick already in flight is skipped, which is the whole point of the guard', () => {
    const now = 1_000_000;
    assert.equal(tickDecision(true, now - 5_000, now, WEDGE), 'skip');
  });

  test('a slow tick is still a running tick, not a wedged one', () => {
    // cheapComplete tries four backends at 90s each, so minutes are legitimate.
    const now = 1_000_000;
    assert.equal(tickDecision(true, now - 5 * 60_000, now, WEDGE), 'skip');
  });

  test('past the threshold the guard stops being believed', () => {
    // The 37-hour telemetry hole: one await never settled, so `finally` never
    // ran, so `running` stayed true and every later tick returned at the guard.
    const now = 1_000_000;
    assert.equal(tickDecision(true, now - WEDGE, now, WEDGE), 'forced');
    assert.equal(tickDecision(true, now - 37 * 60 * 60_000, now, WEDGE), 'forced');
  });

  test('the boundary is inclusive, so an exactly-threshold tick is not skipped forever', () => {
    const now = 1_000_000;
    assert.equal(tickDecision(true, now - (WEDGE - 1), now, WEDGE), 'skip');
    assert.equal(tickDecision(true, now - WEDGE, now, WEDGE), 'forced');
  });
});

describe('what a spoken sentence is taken to mean', () => {
  test('a two-word trigger does not leave half of itself in the note', () => {
    // "jot down buy milk" was stored as "down buy milk": the extraction stripped
    // one word off the front while the trigger was two.
    assert.deepEqual(classify('jot down buy milk'), { kind: 'capture', text: 'buy milk' });
  });

  test('single-word triggers still work, with and without "that"', () => {
    assert.deepEqual(classify('remember that I need milk'), { kind: 'capture', text: 'I need milk' });
    assert.deepEqual(classify('note the door code is 4821'), { kind: 'capture', text: 'the door code is 4821' });
    assert.deepEqual(classify('capture: call the dentist'), { kind: 'capture', text: 'call the dentist' });
  });

  test('the note keeps the casing it was said in', () => {
    // The trigger match is case-insensitive; the stored text is not lowercased,
    // because a note is read by a person later.
    assert.deepEqual(classify('Remember That the operator prefers Postgres'),
                     { kind: 'capture', text: 'the operator prefers Postgres' });
  });

  test('a question is a question, not a note that happens to contain a verb', () => {
    assert.equal(classify('what needs me').kind, 'needs_me');
    assert.equal(classify('status').kind, 'status');
    assert.equal(classify('how do I remember my password').kind, 'ask');
  });

  test('empty speech asks rather than capturing nothing', () => {
    assert.deepEqual(classify('   '), { kind: 'ask', text: '   ' });
  });
});

describe('chunking, which decides what is findable later', () => {
  // Not a bug that shipped - the opposite. This is the one place where a silent
  // fault is unrecoverable: a chunk that never gets built is a fact that can
  // never be retrieved, and nothing downstream can tell that apart from a fact
  // that was never written down. Worth pinning before it changes.

  const headingDoc = (n: number, bodyLen: number) =>
    Array.from({ length: n }, (_, i) => `## Heading ${i}\n` + 'x'.repeat(bodyLen)).join('\n');

  test('indices are contiguous from zero, because they are how a chunk is addressed', () => {
    const chunks = chunkText(headingDoc(40, 200));
    assert.ok(chunks.length > 1);
    assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
  });

  test('a short note stays one chunk and is neither split nor padded', () => {
    assert.deepEqual(chunkText('the door code is 4821'),
                     [{ index: 0, content: 'the door code is 4821', tokenEstimate: 6 }]);
  });

  test('empty input produces nothing rather than one empty chunk', () => {
    assert.deepEqual(chunkText(''), []);
    assert.deepEqual(chunkText('   \n\n  '), []);
  });

  test('every heading in a structured document stays retrievable', () => {
    const joined = chunkText(headingDoc(30, 200)).map((c) => c.content).join('\n');
    for (let i = 0; i < 30; i += 1) {
      assert.ok(joined.includes(`## Heading ${i}`), `lost heading ${i}`);
    }
  });

  test('an oversized block with no boundary is split rather than dropped', () => {
    // Nothing structural to split on, so the hard-split path is the only one
    // that can run; dropping it would lose the document in silence.
    const chunks = chunkText('z'.repeat(9000));
    assert.ok(chunks.length > 1);
    assert.ok(chunks.map((c) => c.content).join('').length >= 9000);
  });

  test('CRLF chunks identically to LF, because notes arrive from Windows', () => {
    const body = headingDoc(20, 150);
    assert.deepEqual(chunkText(body.replace(/\n/g, '\r\n')).map((c) => c.content),
                     chunkText(body).map((c) => c.content));
  });
});

describe('the memory alarm that could not see the outage', () => {
  // On 17 August this machine could not start a JVM or run taskkill. Physical
  // memory was 40% free - three times above the 12% threshold - while commit
  // sat at 99.99%. The alarm watched free RAM alone and was silent throughout.
  const GB = 1024;

  test('the 17 August reading is critical, not fine', () => {
    const p = pressureLevel(13057, 32530, { usedMb: 40328, limitMb: 40722 });
    assert.equal(p.level, 'critical');
    assert.match(p.reason ?? '', /commit/i);
  });

  test('the old rule alone would have called that healthy', () => {
    // Same reading, commit unavailable: 40% free RAM reads as ok, which is
    // exactly the blind spot.
    assert.equal(pressureLevel(13057, 32530, null).level, 'ok');
  });

  test('plenty of commit and plenty of RAM is ok', () => {
    assert.deepEqual(pressureLevel(16 * GB, 32 * GB, { usedMb: 20 * GB, limitMb: 64 * GB }),
                     { level: 'ok', reason: null });
  });

  test('commit warns before it is fatal, so there is time to act', () => {
    const p = pressureLevel(16 * GB, 32 * GB, { usedMb: 90, limitMb: 100 });
    assert.equal(p.level, 'warn');
  });

  test('low RAM still warns when commit is comfortable', () => {
    const p = pressureLevel(1 * GB, 32 * GB, { usedMb: 10, limitMb: 100 });
    assert.equal(p.level, 'warn');
    assert.match(p.reason ?? '', /free of/);
  });

  test('a missing commit reading never reads as healthy on its own', () => {
    // typeperf can fail. Falling back to RAM is right; treating the absence as
    // proof of health would be the same silence in a new place.
    assert.equal(pressureLevel(1 * GB, 32 * GB, null).level, 'warn');
  });

  test('a nonsense commit limit is ignored rather than dividing by zero', () => {
    assert.equal(pressureLevel(16 * GB, 32 * GB, { usedMb: 5, limitMb: 0 }).level, 'ok');
  });
});

describe('which surface a verified caller becomes', () => {
  // Access has already verified identity by the time these run. The question
  // here is narrower and easier to get wrong: how much authority to infer when
  // the configuration does not say.

  test('an unmapped service token gets the least authority, not the most convenient', () => {
    // Was 'phone' (trust 60). 'automation' is trust 20 and is the surface named
    // for machine callers, which is what a service token is. mayDriveSession
    // compares trust, so the gap was concretely the ability to drive sessions
    // that originated on the phone.
    assert.equal(surfaceForPrincipal({ kind: 'service', commonName: 'not-in-the-map' }), 'automation');
  });

  test('a mapped service token gets exactly what the configuration says', () => {
    // The mapping is the place that decision belongs, and it still wins.
    const mapped = Object.keys(config.access.serviceTokens)[0];
    if (!mapped) return; // nothing configured on this machine; nothing to assert
    assert.equal(surfaceForPrincipal({ kind: 'service', commonName: mapped }),
                 config.access.serviceTokens[mapped]);
  });

  test('a verified human is the phone, because that is who is holding it', () => {
    assert.equal(surfaceForPrincipal({ kind: 'user', email: 'sample-account@gmail.com' }), 'phone');
  });

  test('principals describe themselves distinguishably in the audit log', () => {
    // A denial that says only "denied" is not worth writing down.
    assert.equal(describePrincipal({ kind: 'service', commonName: 'reelagent' }), 'service:reelagent');
    assert.equal(describePrincipal({ kind: 'user', email: 'a@b.c' }), 'user:a@b.c');
  });
});

describe('one brain failing should not stop the others being asked', () => {
  // refreshPaidBrainStatuses runs only when the chain's head is already the
  // floor - when every paid brain looks unavailable and Simba is trying to find
  // one that will answer. Under Promise.all, a single throw rejected the sweep,
  // and that propagates out of chainForLaunch into launch(), so the session
  // fails to start at the exact moment recovery was being attempted.

  const okResult = { ok: true, detail: 'fine', ms: 10, model: 'm' };

  test('a thrown probe becomes a failed result, not a lost one', () => {
    const out = settledVerifyResults(
      [{ status: 'rejected', reason: new Error('ECONNREFUSED') } as PromiseSettledResult<never>],
      ['claude-a'],
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.ok, false);
    assert.match(out[0]?.detail ?? '', /claude-a/);
    assert.match(out[0]?.detail ?? '', /ECONNREFUSED/);
  });

  test('the survivors are still returned alongside it', () => {
    const out = settledVerifyResults(
      [
        { status: 'fulfilled', value: okResult },
        { status: 'rejected', reason: new Error('boom') },
        { status: 'fulfilled', value: okResult },
      ] as PromiseSettledResult<typeof okResult>[],
      ['claude-a', 'claude-b', 'codex'],
    );
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((r) => r.ok), [true, false, true]);
  });

  test('a non-Error rejection still produces a readable detail', () => {
    const out = settledVerifyResults(
      [{ status: 'rejected', reason: 'plain string' } as PromiseSettledResult<never>],
      ['cursor'],
    );
    assert.match(out[0]?.detail ?? '', /plain string/);
  });

  test('a failed probe is never reported as available', () => {
    // applyVerifyResult keys off ok, so this is the property that keeps a brain
    // that could not be reached out of the routing chain.
    const out = settledVerifyResults(
      [{ status: 'rejected', reason: new Error('x') } as PromiseSettledResult<never>],
      ['codex'],
    );
    assert.equal(out[0]?.ok, false);
    assert.equal(out[0]?.model, null);
  });
});
