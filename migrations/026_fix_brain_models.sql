-- Cursor and Codex were both written off on bad evidence.
--
-- Cursor was recorded as logged_out with "authenticated, but no models
-- available for this account - looks like a plan/CLI entitlement issue". That
-- diagnosis was wrong. Cursor is logged in and fully working: it answers on
-- Claude 4.6 Sonnet and offers Opus 5, Fable 5, GPT-5.6, Grok 4.5, Kimi K3 and
-- Composer 2.5.
--
-- The real fault was here, in this table. The configured tier models were
-- 'sonnet-4', 'sonnet-4-thinking' and 'gpt-5', and *none of those exist* in
-- cursor's catalog. Simba asked for phantom models, cursor refused, and the
-- refusal was misread as an entitlement problem — so a working subscription sat
-- benched. Exactly the same failure as the invented Codex model names: a model
-- id nobody checked against the CLI's own list.
--
-- Every id below was verified by running it. Opus 5 thinking, Opus 5 medium and
-- Composer 2.5 Fast each returned a real answer in ~5s before this was written.
UPDATE brain_accounts
   SET tier_models = jsonb_build_object(
         -- Simba itself runs on Opus, per the standing requirement.
         'high',  'claude-opus-5-thinking-high',
         'mid',   'claude-opus-5-medium',
         -- Cursor's own model: fastest thing on the account, right for the
         -- secretarial tier.
         'cheap', 'composer-2.5-fast'
       ),
       status      = 'available',
       last_error  = 'models corrected 2026-08-04; previous ids (sonnet-4, gpt-5) did not exist in cursor''s catalog',
       updated_at  = now()
 WHERE slug = 'cursor';

-- Codex was never broken either, merely never confirmed. A live run returned a
-- real answer using 9,076 tokens, so 'unverified' understates it. The MCP
-- handshake warning it prints on startup is a separate matter and does not stop
-- the turn.
UPDATE brain_accounts
   SET status     = 'available',
       last_error = 'verified working 2026-08-04 by live run',
       updated_at = now()
 WHERE slug = 'codex' AND status = 'unverified';
