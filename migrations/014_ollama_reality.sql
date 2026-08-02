-- 014_ollama_reality.sql
-- Corrects the local model mapping against measured behaviour on this GPU.
--
-- Benchmarked on the RTX 3070 (8 GB):
--   qwen2.5:0.5b-instruct             418  tok/s   (instant; classification only)
--   qwen2.5-coder:14b-instruct-q3_K_S  16.6 tok/s  (usable for async work)
--   qwen3-coder:30b-a3b-q4_K_M         FAILS - 500, does not fit in 8 GB
--
-- The 30b was mapped to the local 'high' tier purely on parameter count without
-- ever being run. It cannot load, so any agent routed to it would have failed
-- outright. Local 'high' now points at the largest model that actually works.
--
-- 16.6 tok/s is genuinely slow: a 500-token reply takes ~30s plus up to 8s of
-- cold load. That is fine for background and tier-2 work and poor for anything
-- interactive, which is why the local brain sits at the bottom of the chain as
-- a floor rather than a default.

UPDATE brain_accounts
   SET tier_models = '{"high":"qwen2.5-coder:14b-instruct-q3_K_S",
                       "mid":"qwen2.5-coder:14b-instruct-q3_K_S",
                       "cheap":"qwen2.5-coder:14b-instruct-q3_K_S",
                       "free":"qwen2.5-coder:14b-instruct-q3_K_S",
                       "triage":"qwen2.5:0.5b-instruct"}'::jsonb,
       last_error  = 'local: ~16.6 tok/s on 14b; suited to async and tier-2 work, not interactive',
       updated_at  = now()
 WHERE slug = 'ollama';
