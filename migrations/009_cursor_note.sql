-- 009_cursor_note.sql
-- Corrects the diagnosis recorded in 008.
--
-- `cursor-agent status` reports "Logged in (unable to fetch user details)", so
-- the CLI is authenticated. It nonetheless reports "No models available for
-- this account", which makes this an entitlement problem rather than a login
-- problem: signing in again will not change anything.
--
-- Status stays logged_out because that is the value the routing chain filters
-- on, and a brain that cannot serve a turn must stay out of the chain either
-- way. The note carries the real reason so the fix is not misdirected.

UPDATE brain_accounts
   SET last_error = 'authenticated, but no models available for this account - '
                 || 'looks like a plan/CLI entitlement issue, not a login issue',
       updated_at = now()
 WHERE slug = 'cursor';
