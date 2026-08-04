-- Learn without being asked.
--
-- /learn works but requires someone to invoke it, which means the store fills
-- only when a human remembers to ask or an agent happens to notice mid-task.
-- the operator's objection is the right one: the system should notice on its own.
--
-- learned_at marks a session as already harvested so the supervisor does not
-- re-distil the same work every tick. Nullable and never reset: a session is
-- either a source that has been read or one that has not.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS learned_at timestamptz;

-- The harvest query filters on status and this column on every tick, and there
-- are only ever a handful of unharvested sessions among many.
CREATE INDEX IF NOT EXISTS sessions_unharvested_idx
  ON sessions (status, ended_at)
  WHERE learned_at IS NULL;
