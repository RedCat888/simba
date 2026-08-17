-- The conversation you have with Simba, as opposed to a coding session.
--
-- Every "Talk to Simba" used to INSERT a new sessions row. The phone and the
-- desktop then each had their own thread, and neither could see the other.
-- This table pins one session per agent slug so every surface continues the
-- same talk. Revival and failover still create new session ids; the pin
-- follows the child.

-- ON DELETE CASCADE, because a pin must never be the reason a session cannot be
-- deleted. Without it the probe scripts that clean up after themselves would
-- fail against whichever session happened to be pinned, and the pin is the less
-- important of the two rows: getHomeSessionId() adopts the latest Simba session
-- when it finds nothing pinned, so losing the pin costs a lookup, not a thread.
CREATE TABLE home_threads (
    agent_slug text PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX home_threads_session_idx ON home_threads (session_id);
