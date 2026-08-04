-- Make script missions visible in the list the app reads.
--
-- mission_progress predates script missions, so a scheduled script appeared as
-- a mission with no steps, no cost and nothing to show - indistinguishable from
-- one that had failed to plan. The fields that make it legible are its
-- schedule, when it last ran, and whether that run succeeded.
--
-- New columns are appended rather than inserted. CREATE OR REPLACE VIEW keeps
-- existing columns at their existing positions, and reordering them is both
-- refused by Postgres and a way to break any consumer reading positionally.
CREATE OR REPLACE VIEW mission_progress AS
SELECT m.id,
       m.title,
       m.status,
       m.cadence,
       m.sessions_used,
       m.max_sessions,
       -- Cast held to the view's existing type: CREATE OR REPLACE refuses a
       -- change, and widening it silently would break nothing loudly.
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
       -- Appended below this line.
       m.cron,
       -- Non-null script marks this as a script mission: no model, no session,
       -- no steps. Without it such a mission reads as one that failed to plan.
       (m.script IS NOT NULL) AS is_script,
       m.last_run_at,
       m.last_exit_code,
       left(coalesce(m.last_output, ''), 400) AS last_output
  FROM missions m
  LEFT JOIN agents a ON a.id = m.owner_agent_id;
