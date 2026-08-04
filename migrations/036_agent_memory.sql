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

-- Seed with what this build has already established and keeps re-discovering.
INSERT INTO agent_memory (agent_id, kind, content, source) VALUES
(NULL, 'environment', 'This machine is Windows 11. Shell commands run under PowerShell or Git Bash, not a POSIX shell — /dev/null, $VAR and here-strings behave differently.', 'observed repeatedly'),
(NULL, 'environment', 'Postgres is at 127.0.0.1:5432, database simba, user postgres. There is no "simba" role; using it fails with "role does not exist".', 'cost two failed commands'),
(NULL, 'environment', 'psql lives at C:\Users\operator\scoop\apps\postgresql\current\bin\psql.exe and is not on PATH.', 'observed'),
(NULL, 'environment', 'The gateway runs on 127.0.0.1:8787 (local, trusted) and 8788 (tunnel, Access-verified). Restarting it also restarts the supervisor.', 'architecture'),
(NULL, 'convention', 'Postgres is the only source of truth. Never write state, plans or handoffs to markdown files — research notes are the sole exception.', 'standing instruction from the operator'),
(NULL, 'convention', 'Subscriptions only. Never introduce API-key spending. Free tiers and local models are fine.', 'standing instruction from the operator'),
(NULL, 'convention', 'Verify through the front door: check the outcome in the system of record, never trust a tool reporting its own success.', 'repeatedly necessary'),
(NULL, 'convention', 'Pin explicit model ids, never aliases. "opus" silently resolved to claude-opus-4-7 for weeks.', 'real incident'),
(NULL, 'person', 'the operator prefers being told plainly what is broken over reassurance, and wants work done rather than proposed. Do not ask permission for ordinary work.', 'stated directly, several times'),
(NULL, 'person', 'the operator owns a Windows PC, a MacBook, and a Samsung S24 which is the primary way he drives Simba.', 'stated'),
(NULL, 'convention', 'Never touch the an external project Supabase project (rqfpsvzigiyljcucoouk).', 'standing instruction from the operator')
ON CONFLICT (agent_id, content) DO NOTHING;
