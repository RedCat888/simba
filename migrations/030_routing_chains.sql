-- Put the free brain in the chains, and make tier 0 actually reach Opus 5.
--
-- Two problems, both invisible until the chains were printed.
--
-- First: opencode appeared in no chain at all. Every routing policy predates
-- it, so a brain that costs nothing and answers competently was unreachable
-- through normal routing. It could be selected only by naming it explicitly,
-- which nothing does. The whole point of adding a free tier is that ordinary
-- work lands on it.
--
-- Second, and worse: resolveBrainChain prefers an explicit brain_chain and only
-- falls back to priority ordering when no policy matches. Reordering
-- brain_accounts.priority so Opus 5 came before Sol therefore changed nothing
-- for any agent — every tier has a policy. Tier 0's chain was
-- claude-a -> claude-b -> codex, so cursor was absent and the first fallback
-- after two Claude accounts was GPT-5.6 Sol. The requirement was Opus 5
-- primary with Sol as backup; the table said so and the routing did not.
--
-- Ordering rules applied below:
--   * Opus 5 wherever it exists, exhausted before dropping to Sol.
--   * claude-b before claude-a: b is the higher-priority account and a has been
--     running closer to its limit.
--   * opencode below the subscriptions but above ollama for real work — free,
--     capable, ~30s per turn. Ollama stays last as the offline floor, the only
--     rung that survives having no network.

-- Tier 0 — Simba. Three Opus 5 rungs, then Sol.
UPDATE routing_policies
   SET brain_chain = ARRAY(
         SELECT id FROM brain_accounts WHERE slug = 'claude-b'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'claude-a'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'cursor'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'codex'
       )
 WHERE applies_to_tier = 0;

-- Tier 1 — domain agents. Same order, with the free tier underneath so a
-- fully-exhausted subscription set degrades to something that still works
-- rather than parking the agent.
UPDATE routing_policies
   SET brain_chain = ARRAY(
         SELECT id FROM brain_accounts WHERE slug = 'claude-b'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'claude-a'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'cursor'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'codex'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'opencode'
       )
 WHERE applies_to_tier = 1;

-- Tier 2 — workers. Free first, deliberately.
--
-- This is the tier that exists in bulk and runs unattended, so it is where
-- spending subscription headroom is least defensible. The previous chain led
-- with ollama, which is free but follows instructions poorly enough to be
-- unreliable for real work; opencode is free too and measurably better, so it
-- leads and ollama becomes the fallback beneath it.
UPDATE routing_policies
   SET brain_chain = ARRAY(
         SELECT id FROM brain_accounts WHERE slug = 'opencode'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'ollama'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'claude-b'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'claude-a'
       )
 WHERE applies_to_tier = 2 AND priority = 5;

UPDATE routing_policies
   SET brain_chain = ARRAY(
         SELECT id FROM brain_accounts WHERE slug = 'opencode'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'ollama'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'claude-b'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'claude-a'
         UNION ALL SELECT id FROM brain_accounts WHERE slug = 'codex'
       )
 WHERE applies_to_tier = 2 AND priority = 30;
