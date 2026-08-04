-- Keep the phrase, not just the cron it compiled to.
--
-- Schedules are stated in English ("every morning", "weekdays at 9"), parsed
-- into cron, and then the English was thrown away — it survived only in the
-- creation response and the mission log. So the only thing any surface could
-- show afterwards was `0 7 * * *`, which is a correct answer to a question
-- nobody asked. On a phone row it reads as line noise.
--
-- Two facts, both worth keeping and neither derivable from the other: what the
-- person said, and what it was understood to mean. A round-trip through cron
-- loses "every morning" — 07:00 is a choice the parser made, and seeing it
-- stated back is how a misparse becomes visible.
ALTER TABLE missions ADD COLUMN IF NOT EXISTS schedule_note text;

COMMENT ON COLUMN missions.schedule_note IS
  'Human-readable schedule as the parser understood it, e.g. "every day at 07:00". Null for missions that are not scheduled.';

-- Backfill what can be recovered. Only the handful of shapes the parser itself
-- emits are worth reversing; anything else keeps its cron, which is still more
-- honest than inventing a phrase for an expression nobody typed.
UPDATE missions
   SET schedule_note = CASE
     WHEN cron ~ '^0 [0-9]{1,2} \* \* \*$'
       THEN 'every day at ' || lpad(split_part(cron, ' ', 2), 2, '0') || ':00'
     WHEN cron ~ '^0 [0-9]{1,2} \* \* 1-5$'
       THEN 'weekdays at ' || lpad(split_part(cron, ' ', 2), 2, '0') || ':00'
     WHEN cron ~ '^\*/[0-9]+ \* \* \* \*$'
       THEN 'every ' || replace(split_part(cron, ' ', 1), '*/', '') || ' minutes'
     WHEN cron ~ '^0 \*/[0-9]+ \* \* \*$'
       THEN 'every ' || replace(split_part(cron, ' ', 2), '*/', '') || ' hours'
     ELSE NULL
   END
 WHERE cron IS NOT NULL AND schedule_note IS NULL;

-- Appended, never inserted: CREATE OR REPLACE VIEW keeps existing columns where
-- they are, and reordering is both refused by Postgres and a way to break any
-- consumer reading positionally.
CREATE OR REPLACE VIEW mission_progress AS
SELECT m.id,
       m.title,
       m.status,
       m.cadence,
       m.sessions_used,
       m.max_sessions,
       m.cost_used_usd::numeric AS cost_used,
       m.max_cost_usd,
       m.consecutive_failures,
       m.blocked_reason,
       m.created_at,
       m.updated_at,
       a.slug AS agent,
       (SELECT count(*)::int FROM mission_steps s WHERE s.mission_id = m.id) AS total_steps,
       (SELECT count(*)::int FROM mission_steps s WHERE s.mission_id = m.id AND s.status IN ('succeeded','skipped')) AS done_steps,
       (SELECT count(*)::int FROM mission_steps s WHERE s.mission_id = m.id AND s.status = 'failed') AS failed_steps,
       (SELECT s.title FROM mission_steps s WHERE s.mission_id = m.id AND s.status = 'running' ORDER BY s.seq LIMIT 1) AS current_step,
       m.cron,
       (m.script IS NOT NULL) AS is_script,
       m.last_run_at,
       m.last_exit_code,
       left(coalesce(m.last_output, ''), 400) AS last_output,
       -- Appended below this line.
       m.schedule_note
  FROM missions m
  LEFT JOIN agents a ON a.id = m.owner_agent_id;
