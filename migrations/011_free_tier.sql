-- 011_free_tier.sql
-- Adds a fourth model tier: 'free'.
--
-- The point of the tier is budget shape, not capability. Titling, summarizing,
-- checkpoint authoring, intent classification and most tier-2 worker tasks do
-- not need a frontier model, and spending subscription headroom on them is the
-- single easiest way to make a $20 plan run out early. A local model does them
-- for nothing.

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_model_tier_check;
ALTER TABLE agents ADD CONSTRAINT agents_model_tier_check
    CHECK (model_tier IN ('high', 'mid', 'cheap', 'free'));

ALTER TABLE routing_policies DROP CONSTRAINT IF EXISTS routing_policies_model_tier_check;
ALTER TABLE routing_policies ADD CONSTRAINT routing_policies_model_tier_check
    CHECK (model_tier IN ('high', 'mid', 'cheap', 'free'));

ALTER TABLE brain_accounts DROP CONSTRAINT IF EXISTS brain_accounts_kind_check;
ALTER TABLE brain_accounts ADD CONSTRAINT brain_accounts_kind_check
    CHECK (kind IN ('subscription', 'api_key', 'local'));

-- Ollama as a brain account. kind='local' so cost accounting can treat it as
-- structurally free rather than as a subscription that happens to cost nothing:
-- it has no usage window, no reset time, and can never be exhausted, so the
-- supervisor must never bench it or schedule a wake against it.
INSERT INTO brain_accounts
    (id, slug, label, provider, kind, cli, config_dir, tier_models, priority, status) VALUES
    ('11111111-1111-1111-1111-111111111105', 'ollama', 'Local models (Ollama)',
     'local', 'local', 'ollama', NULL,
     -- Sized against an RTX 3070's 8 GB: the 14b q3 largely fits in VRAM, while
     -- the 30b models spill to CPU and are markedly slower. The tiny models are
     -- for classification and triage where latency matters more than depth.
     '{"high":"qwen3-coder:30b-a3b-q4_K_M",
       "mid":"qwen2.5-coder:14b-instruct-q3_K_S",
       "cheap":"qwen2.5-coder:14b-instruct-q3_K_S",
       "free":"qwen2.5-coder:14b-instruct-q3_K_S",
       "triage":"qwen2.5:0.5b-instruct"}'::jsonb,
     100, 'available')
ON CONFLICT (slug) DO UPDATE
    SET tier_models = EXCLUDED.tier_models,
        status      = 'available',
        updated_at  = now();

-- Tier-2 workers default to free and fall back to the subscriptions only if the
-- local brain is unreachable.
INSERT INTO routing_policies
    (slug, name, applies_to_tier, model_tier, brain_chain, on_exhausted, priority) VALUES
    ('tier2-free-first', 'Workers: local models first', 2, 'free',
     ARRAY['11111111-1111-1111-1111-111111111105',
           '11111111-1111-1111-1111-111111111102',
           '11111111-1111-1111-1111-111111111101']::uuid[],
     'sleep_until_reset', 5)
ON CONFLICT (slug) DO UPDATE
    SET brain_chain = EXCLUDED.brain_chain,
        model_tier  = EXCLUDED.model_tier,
        priority    = EXCLUDED.priority;
