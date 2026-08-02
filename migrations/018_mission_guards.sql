-- 018_mission_guards.sql
--
-- Fixes a runaway session spawner and adds a defence against the class.
--
-- The executor started a planning session whenever a mission had no steps yet.
-- Planning takes minutes; the tick runs every 15 seconds. Nothing recorded that
-- planning was already underway, so every tick started another one — nine
-- sessions and about a dollar before it was caught.
--
-- Two separate fixes, deliberately. The specific one stops this bug. The
-- general one is a ceiling on concurrent sessions per mission, because
-- "spawned more work than intended" is the failure mode most worth having a
-- structural guard against: it is silent, it accelerates, and it costs money.

ALTER TABLE missions ADD COLUMN planning_session_id uuid REFERENCES sessions(id);
ALTER TABLE missions ADD COLUMN max_concurrent_sessions int NOT NULL DEFAULT 1;

-- Sessions genuinely attributable to a mission right now: the planning session
-- plus any step sessions still live.
CREATE OR REPLACE VIEW mission_live_sessions AS
SELECT m.id AS mission_id,
       count(s.id)::int AS live
  FROM missions m
  LEFT JOIN sessions s
    ON s.status IN ('pending', 'running')
   AND (s.id = m.planning_session_id
        OR s.id IN (SELECT st.session_id FROM mission_steps st
                     WHERE st.mission_id = m.id AND st.status = 'running'))
 GROUP BY m.id;
