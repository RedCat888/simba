-- Tier 0 runs Opus 5, with GPT-5.6 Sol behind it.
--
-- Simba's top tier was configured with the alias 'opus', which reads as "the
-- best Opus available" and is not. It resolves to claude-opus-4-7 — verified by
-- running it and reading back the model the CLI reported. So the agent meant to
-- be the most capable thing in the system has been a generation behind, silently,
-- while the table looked correct. 'sonnet' had drifted the same way, to
-- claude-sonnet-4-6.
--
-- Aliases are the problem. They look like they track the latest model and
-- instead pin to whatever the CLI decided at some point, which means the drift
-- is invisible from here — nothing in Simba was ever wrong, so nothing could be
-- noticed. Every id below is explicit and was verified by a live call that
-- echoed the model back.
--
-- 'haiku' is deliberately left alone: it resolves to claude-haiku-4-5, which is
-- current. Pinning it would create the opposite failure, where a real upgrade
-- never arrives.
--
-- The ladder now reads: Opus 5 (claude-b) → Opus 5 (claude-a) → Opus 5 (cursor)
-- → GPT-5.6 Sol (codex). Opus 5 primary, Sol as the backup, which is what tier 0
-- was supposed to be.

UPDATE brain_accounts
   SET tier_models = jsonb_build_object(
         'high',  'claude-opus-5',
         'mid',   'claude-sonnet-5',
         -- Alias kept on purpose; it already points at the current Haiku.
         'cheap', 'haiku'
       ),
       updated_at = now()
 WHERE slug IN ('claude-a', 'claude-b');

-- Codex is the Sol backup. It was on gpt-5.6-terra; sol is the frontier model in
-- its own catalog (priority 1, "Latest frontier agentic coding model") and
-- answered a live call in 12.8s.
UPDATE brain_accounts
   SET tier_models = jsonb_set(tier_models, '{high}', '"gpt-5.6-sol"'),
       updated_at = now()
 WHERE slug = 'codex';

-- Cursor already carries Opus 5 from the previous fix, but it sat *below* codex
-- in the ladder — so the first fallback was Sol, and Opus 5 only came back after
-- it. That inverts the intent. Opus 5 is the primary and Sol is the backup, so
-- every Opus 5 rung should be exhausted before dropping to Sol.
UPDATE brain_accounts SET priority = 30, updated_at = now() WHERE slug = 'cursor';
UPDATE brain_accounts SET priority = 40, updated_at = now() WHERE slug = 'codex';
