-- 008_cursor_status.sql
-- The Cursor CLI reports "No models available for this account", so it cannot
-- serve a turn until it is logged in. Marking it logged_out keeps it out of
-- every routing chain (the chain filter excludes that status) rather than
-- letting failover pick a brain that is guaranteed to fail.
--
-- Model ids are the ones cursor-agent --help documents; they are unverified
-- against a live account and should be confirmed with --list-models once
-- authentication works.

UPDATE brain_accounts
   SET status      = 'logged_out',
       last_error  = 'cursor-agent reports no models available; run cursor-agent and sign in',
       tier_models = '{"high":"sonnet-4-thinking","mid":"sonnet-4","cheap":"gpt-5"}'::jsonb,
       updated_at  = now()
 WHERE slug = 'cursor';
