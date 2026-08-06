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
import { parseSchedule } from '../src/missions/schedule.js';

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
