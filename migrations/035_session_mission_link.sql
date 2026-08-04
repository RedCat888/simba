-- Attribute every session to its mission, durably.
--
-- Mission cost was summed by joining mission_steps to the session each step
-- *currently* references. Three kinds of spend escaped that entirely:
--
--   * planning, because planning_session_id is cleared once the plan lands;
--   * every superseded attempt, because requeueing clears session_id and the
--     next attempt overwrites it;
--   * every failed-over session, for the same reason.
--
-- So a mission that planned expensively, or failed and retried repeatedly,
-- could spend well past max_cost_usd while the recorded figure sat below it —
-- and the budget ceiling is enforced against the recorded figure. The one
-- control standing between an unattended objective and unbounded spend was
-- measuring the wrong thing.
--
-- A column on sessions is the right place for this because a session belongs to
-- a mission permanently. Deriving the relationship from whichever pointer
-- happens to be current is what created the gap.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mission_id uuid REFERENCES missions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sessions_mission_idx ON sessions (mission_id) WHERE mission_id IS NOT NULL;

-- Backfill what is still recoverable: sessions a step or a mission still points
-- at. Attempts already overwritten are gone, which is the point of the fix.
UPDATE sessions s
   SET mission_id = st.mission_id
  FROM mission_steps st
 WHERE st.session_id = s.id
   AND s.mission_id IS NULL;

UPDATE sessions s
   SET mission_id = m.id
  FROM missions m
 WHERE m.planning_session_id = s.id
   AND s.mission_id IS NULL;
