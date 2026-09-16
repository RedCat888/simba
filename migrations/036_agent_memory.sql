-- Bounded, editable memory. The counterpart to skills.
--
-- Simba has 30,773 vectors of recall and no memory. Those are different things:
-- recall answers "have I seen this before" when asked, memory is what an agent
-- knows without being asked. An agent that has to search for the fact that this
-- machine runs Windows, or that Postgres is reached as `postgres` and not
-- `simba`, will usually just not search.
--
-- Taken from Hermes, whose MEMORY.md/USER.md split is the good idea: memory is
-- deliberately **bounded** and human-readable, not an unlimited store that
-- silently accretes. A cap that forces consolidation is what stops it becoming
-- another vector database nobody reads. When it is full the agent must remove or
-- merge something to add something, which is the same discipline a person
-- applies to a page of notes.
--
-- Stored as rows rather than the markdown files Hermes uses, for the same reason
-- skills are: Postgres is the source of truth here, and a file on this disk is
-- unreadable to an agent running anywhere else.

CREATE TABLE IF NOT EXISTS agent_memory (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  /**
   * NULL means every agent sees it — facts about the machine, the accounts, the
   * conventions. An agent id scopes it to one. Most memory is shared; the split
   * exists so a domain agent's specifics do not crowd out everyone's context.
   */
  agent_id    uuid REFERENCES agents(id) ON DELETE CASCADE,

  -- Hermes splits environment facts from user preferences. Same distinction,
  -- as a column, so the brief can group them and a cap can apply per kind.
  kind        text NOT NULL CHECK (kind IN ('environment', 'preference', 'convention', 'person')),

  -- One fact. Short by construction: this is loaded on every single turn.
  content     text NOT NULL CHECK (length(content) BETWEEN 4 AND 400),

  -- Why it is believed, and by whom. A memory with no provenance cannot be
  -- audited later, and this store is small enough to afford the column.
  source      text,
  learned_at  timestamptz NOT NULL DEFAULT now(),

  -- Touched when the memory demonstrably mattered, so consolidation has
  -- evidence rather than a guess about what to drop.
  confirmed_at timestamptz,
  confirmations integer NOT NULL DEFAULT 0,

  created_by_session uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- Identical facts stated twice are the main way a bounded store fills up with
  -- nothing.
  UNIQUE (agent_id, content)
);

CREATE INDEX IF NOT EXISTS agent_memory_scope_idx ON agent_memory (agent_id, kind);

/**
 * The cap, enforced in the database rather than trusted to the caller.
 *
 * A limit that lives only in application code is a limit that a second writer
 * ignores. 40 global plus 20 per agent is roughly two screens of text — enough
 * to be genuinely useful, small enough that an agent is forced to choose.
 */
CREATE OR REPLACE FUNCTION enforce_memory_cap() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_count integer;
  v_cap   integer;
BEGIN
  IF NEW.agent_id IS NULL THEN
    SELECT count(*) INTO v_count FROM agent_memory WHERE agent_id IS NULL;
    v_cap := 40;
  ELSE
    SELECT count(*) INTO v_count FROM agent_memory WHERE agent_id = NEW.agent_id;
    v_cap := 20;
  END IF;

  IF TG_OP = 'INSERT' AND v_count >= v_cap THEN
    RAISE EXCEPTION
      'memory is full (% of % entries). Remove or merge something before adding — '
      'that choice is the point of a bounded store.', v_count, v_cap
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_memory_cap ON agent_memory;
CREATE TRIGGER agent_memory_cap
  BEFORE INSERT ON agent_memory
  FOR EACH ROW EXECUTE FUNCTION enforce_memory_cap();

-- Deliberately no seed memories. Add environment facts and operator preferences
-- only in the local database after deployment; they must never be committed.
