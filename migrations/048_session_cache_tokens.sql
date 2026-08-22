-- Session token totals were missing every cache token ever billed.
--
-- sessions.total_input_tokens summed only usage.input_tokens, leaving out
-- cache_creation_tokens and cache_read_tokens. Both are input, both are
-- charged, and on this workload they are almost all of it: a live test sent one
-- sentence to the home thread and the session recorded 2 input tokens beside a
-- cost of $1.7758, because reviving that thread wrote 177,547 tokens of cache.
--
-- The number is read in more places than it looks. The operator CLI prints it,
-- the sessions API returns it, and mission cost roll-ups reason about spend
-- from these rows - so a total that contradicts the cost next to it makes every
-- one of those misleading rather than merely incomplete.
--
-- GREATEST rather than a plain overwrite: usage is authoritative where it
-- exists, but a session whose usage rows were lost should not have its total
-- silently reduced to zero.

UPDATE sessions s
   SET total_input_tokens = GREATEST(
         s.total_input_tokens,
         (SELECT coalesce(sum(u.input_tokens + u.cache_creation_tokens + u.cache_read_tokens), 0)
            FROM usage u WHERE u.session_id = s.id)
       )
 WHERE EXISTS (SELECT 1 FROM usage u WHERE u.session_id = s.id);
