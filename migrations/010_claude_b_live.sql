-- 010_claude_b_live.sql
-- Account B is logged in and verified as a genuinely separate subscription
-- (different email, different org, Team rather than Pro), so same-tool failover
-- now has somewhere real to go: transcript copy plus --resume, near-lossless.

UPDATE brain_accounts
   SET status     = 'available',
       label      = 'Claude Team (Srswebsolutions)',
       last_error = NULL,
       updated_at = now()
 WHERE slug = 'claude-b';

-- Claude-a is a Pro plan and claude-b is Team. Team generally carries more
-- headroom, so it is worth preferring for sustained tier-1 work while leaving
-- the personal Pro account for interactive use. Priority is the chain order.
UPDATE brain_accounts SET priority = 10 WHERE slug = 'claude-b';
UPDATE brain_accounts SET priority = 20 WHERE slug = 'claude-a';
