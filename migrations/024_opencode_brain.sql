-- OpenCode as a brain account.
--
-- Placed at priority 90: ahead of Ollama, behind every subscription. The
-- ordering is the failover ladder, and each position is a claim about the
-- trade-off at that rung.
--
-- Behind the subscriptions because it is slow. A turn carries ~30s of CLI
-- start-up before the model is even reached, which is fine for a worker and
-- wrong for anything a human is waiting on.
--
-- Ahead of Ollama because it is strictly better on the axis that matters at
-- this rung. Both are free and neither can be rate-limited into uselessness,
-- but the local 14b quant follows instructions poorly enough that it cannot be
-- trusted with real work, while OpenCode's free tier ran a read-a-file task
-- correctly on the first attempt. Ollama stays below it as the offline floor:
-- it is the only rung that survives having no network at all.
--
-- `kind` needed a new value. The existing set — subscription / api_key / local
-- — has no honest slot for this: it consumes no plan headroom, needs no key,
-- and is not local. Filing it under any of the three would make the budget
-- maths wrong in the direction that matters, so the constraint gains 'free'.
-- Nothing in the code branches on kind today; it is descriptive, and the point
-- of the value is that it stays accurate when something does.
ALTER TABLE brain_accounts DROP CONSTRAINT IF EXISTS brain_accounts_kind_check;
ALTER TABLE brain_accounts ADD CONSTRAINT brain_accounts_kind_check
  CHECK (kind = ANY (ARRAY['subscription', 'api_key', 'local', 'free']));

-- `provider` needs the same treatment. The existing list names the model
-- vendors directly, but OpenCode is an aggregator — whose model is actually
-- serving a request is its routing decision, not ours, and it can change under
-- us without notice. Naming the aggregator is the only claim that stays true.
ALTER TABLE brain_accounts DROP CONSTRAINT IF EXISTS brain_accounts_provider_check;
ALTER TABLE brain_accounts ADD CONSTRAINT brain_accounts_provider_check
  CHECK (provider = ANY (ARRAY['anthropic', 'openai', 'cursor', 'google', 'local', 'opencode']));

INSERT INTO brain_accounts (id, slug, label, provider, kind, cli, config_dir, env, tier_models, priority, enabled, status, last_error)
VALUES (
  '11111111-1111-1111-1111-111111111106',
  'opencode',
  'OpenCode (free tier)',
  'opencode',
  'free',
  'opencode',
  NULL,
  '{}'::jsonb,
  -- One model across every tier because only one free model actually works.
  -- Probing found minimax-m2.5-free and gpt-5-nano returning server errors, and
  -- the github-copilot entries authenticating but reporting "not licensed to
  -- use Copilot". Naming a model that does not answer is how a brain silently
  -- fails every turn, so this lists only what was verified.
  '{"high": "opencode/big-pickle", "mid": "opencode/big-pickle", "cheap": "opencode/big-pickle", "free": "opencode/big-pickle"}'::jsonb,
  90,
  true,
  'available',
  'free tier: verified 5/5 on completions, ~30s per turn (mostly CLI start-up); suited to workers and async work, not interactive'
)
ON CONFLICT (slug) DO UPDATE SET
  cli         = EXCLUDED.cli,
  kind        = EXCLUDED.kind,
  tier_models = EXCLUDED.tier_models,
  priority    = EXCLUDED.priority,
  updated_at  = now();
