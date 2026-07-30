-- 007_codex_models.sql
-- Correct the Codex tier mapping.
--
-- The original values in 006 were invented. A ChatGPT subscription rejects
-- models it does not serve ("The 'gpt-5.2' model is not supported when using
-- Codex with a ChatGPT account"), so a wrong id fails the turn outright rather
-- than falling back. These ids come from the account's own models_cache.json.

UPDATE brain_accounts
   SET tier_models = '{"high":"gpt-5.6-terra","mid":"gpt-5.6-luna","cheap":"gpt-5.4-mini"}'::jsonb,
       updated_at  = now()
 WHERE slug = 'codex';
