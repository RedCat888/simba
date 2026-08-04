-- Skills: procedures the system learns once and reuses.
--
-- Ported from Hermes Agent, whose insight is an economic one. A skill's
-- *description* is paid for on every single turn, because the index has to sit
-- in the system prompt for the agent to know the skill exists at all. Its
-- *body* is paid for only when actually used. So the index is kept brutally
-- short — a name and a truncated trigger phrase — and bodies load on demand
-- through a tool. Hermes truncates to 57 characters; the same budget applies
-- here, for the same reason.
--
-- The self-improving part is not machinery, it is instruction: the standing
-- brief tells agents to save a procedure once they have worked it out, and to
-- patch a skill the moment they find it wrong, without being asked. The tables
-- exist so that instruction has somewhere to write.
--
-- Where this diverges from Hermes: skills live in Postgres rather than as
-- SKILL.md files on disk. That is not stylistic. Simba's rule is that Postgres
-- is the source of truth and markdown is never state — a skills tree on disk
-- would be exactly the kind of parallel state store that rule exists to
-- prevent, and it could not be read by an agent running on another machine.

CREATE TABLE IF NOT EXISTS skills (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Lowercase kebab. This is the handle agents pass to skill_view.
  name               text NOT NULL UNIQUE
                       CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),

  -- Trigger-first, e.g. "Use when a Windows CLI hangs with no output."
  -- Only the first 57 characters reach the system prompt, so the trigger has to
  -- come first or the index entry says nothing useful.
  description        text NOT NULL CHECK (length(description) BETWEEN 8 AND 1024),

  body               text NOT NULL CHECK (length(body) > 0),

  tags               text[] NOT NULL DEFAULT '{}',
  related            text[] NOT NULL DEFAULT '{}',

  -- Gating. Empty means "applies everywhere", which is the common case. These
  -- exist so the index does not spend its token budget advertising skills that
  -- cannot possibly apply to the agent reading it.
  applies_to_agents  text[] NOT NULL DEFAULT '{}',
  platforms          text[] NOT NULL DEFAULT '{}',

  -- 'learned' is the interesting one: written by an agent mid-work rather than
  -- authored deliberately. Kept distinct so it is possible to ask what the
  -- system has taught itself, and to review it.
  source             text NOT NULL DEFAULT 'authored'
                       CHECK (source IN ('authored', 'learned', 'imported')),

  version            integer NOT NULL DEFAULT 1,
  enabled            boolean NOT NULL DEFAULT true,

  -- Usage is recorded so index space can be earned rather than assumed. A skill
  -- nobody ever opens is costing tokens on every turn and returning nothing;
  -- without this there is no way to know which ones those are.
  use_count          integer NOT NULL DEFAULT 0,
  last_used_at       timestamptz,

  created_by_session uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS skills_enabled_idx ON skills (enabled, use_count DESC);
CREATE INDEX IF NOT EXISTS skills_tags_idx ON skills USING gin (tags);

-- Every edit keeps the version it replaced.
--
-- Agents are told to patch skills they find wrong, which means skills will be
-- rewritten by a model that was mid-task and may have been mistaken. Without
-- history a bad patch silently destroys a working procedure and nothing can say
-- what it used to be.
CREATE TABLE IF NOT EXISTS skill_revisions (
  skill_id           uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version            integer NOT NULL,
  description        text NOT NULL,
  body               text NOT NULL,
  note               text,
  created_by_session uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, version)
);

-- Seed skills.
--
-- These are not illustrations; each one is a lesson this build already paid for
-- in wasted hours, written down so it is paid for once. Together they also
-- serve as the worked examples an agent will imitate when it writes its own —
-- which is why each is a concrete procedure with commands, not advice.
INSERT INTO skills (name, description, body, tags, source) VALUES
(
  'windows-cli-hangs-on-stdin',
  'Use when a CLI returns empty output and exits null on Windows.',
  E'# A CLI that hangs with no output on Windows\n\n'
  'A child process that produces `exit null`, empty stdout and empty stderr has '
  'almost certainly not crashed — it has not started. That signature is a timeout.\n\n'
  '## Cause\n\n'
  'Many CLIs read stdin when no terminal is attached, and wait forever. '
  '`execFile` gives you no handle to close it. Confirmed on both `codex` and '
  '`opencode`, and it presents as "the service is down" rather than as a bug in '
  'the calling code, which is what makes it expensive to diagnose.\n\n'
  '## Fix\n\n'
  '```ts\n'
  'const proc = spawn(bin, args, { windowsHide: true });\n'
  'try { proc.stdin.end(); } catch { /* already closed */ }\n'
  '```\n\n'
  'Use `spawn`, not `execFile`, specifically so stdin can be closed. If the tool '
  'needs a prompt, write it then end: `proc.stdin.write(body); proc.stdin.end();`\n\n'
  '## Related\n\n'
  'Prompts should go over stdin anyway — Windows caps a command line near 32k and '
  'a hydration brief will exceed it.',
  ARRAY['windows','process','debugging','cli'],
  'authored'
),
(
  'verify-through-the-front-door',
  'Use before claiming a fix works. Check the outcome, not the log.',
  E'# Verify through the front door\n\n'
  'A tool reporting success is not evidence the effect happened. Check the thing '
  'itself, by the same route a user would.\n\n'
  '## Procedure\n\n'
  '1. Name the observable that changes if the fix worked.\n'
  '2. Read it from the system of record, not from the process that just wrote it.\n'
  '3. If they disagree, the process is wrong until proven otherwise.\n\n'
  '## Worked examples from this build\n\n'
  '- An MCP tool returned "Noted." and the model reported success. The row was '
  'confirmed by querying Postgres directly — trusting the reply would have proven '
  'nothing.\n'
  '- An APK upload said "Upload complete." Verification was re-downloading the '
  'published file and comparing its SHA-256 to the local build.\n'
  '- `claudeCheapComplete` returned null on every successful call for weeks '
  'because it parsed an event array as an object. Null was indistinguishable '
  'from "the model found nothing", so nothing ever surfaced.\n\n'
  '## The general trap\n\n'
  'Any code path whose failure mode is an empty result will hide indefinitely. '
  'Log the difference between "failed" and "found nothing".',
  ARRAY['verification','discipline','debugging'],
  'authored'
),
(
  'free-model-tiers',
  'Use when picking a model for background or bulk work.',
  E'# Choosing a free tier\n\n'
  'Cheap work — titling, summarising, checkpoints, extraction — should never '
  'touch subscription headroom. Measured options on this machine:\n\n'
  '| Provider | Key | Speed | Quality |\n'
  '|---|---|---|---|\n'
  '| OpenCode `opencode/big-pickle` | none | ~30s/call | good, follows instructions |\n'
  '| Ollama `qwen2.5-coder:14b` | none | ~16 tok/s | poor at precise instructions |\n'
  '| Claude Haiku | subscription | fast | good |\n\n'
  '## Rules\n\n'
  '- Background and bulk work: OpenCode free. 30s does not matter when nobody waits.\n'
  '- Anything on a per-turn hot path: pass `preferSpeed` — 30s per turn taxes the '
  'whole system.\n'
  '- Output that is permanent and volume is bounded (decision extraction): pass '
  '`preferQuality` and use the subscription. A 14b quant returns facts when told '
  'to return only decisions.\n\n'
  '## Models that do not work\n\n'
  '`minimax-m2.5-free` and `gpt-5-nano` return server errors. `github-copilot/*` '
  'authenticate but report "not licensed to use Copilot". Naming a dead model is '
  'how a brain silently fails every turn.',
  ARRAY['models','cost','routing'],
  'authored'
)
ON CONFLICT (name) DO NOTHING;
