-- Global memory has never been able to dedupe or record a confirmation.
--
-- agent_memory is written with ON CONFLICT (agent_id, content) DO UPDATE, which
-- is meant to turn a re-learned fact into a confirmations increment rather than
-- a second row. For agent-scoped memories that works. For global memories -
-- agent_id IS NULL, which is most of them - it never fires at all, because a
-- plain UNIQUE index treats NULLs as distinct, so no two rows ever conflict.
--
-- The evidence, before this migration: 23 global memories holding 13 distinct
-- facts, and 0 of 23 with confirmations above zero. Ten of forty slots in a
-- deliberately bounded store were exact duplicates of facts like "Never touch
-- the an external project Supabase project" and "Subscriptions only" - and every one of those
-- duplicates was a re-learning that should have strengthened the original.
--
-- It also broke the ordering. buildMemorySection ranks by confirmations DESC to
-- put the most-reinforced facts first in a section that is 41% of every agent's
-- brief. With every count stuck at zero, that clause has never sorted anything.

-- 1. Merge the duplicates, carrying the re-learnings into confirmations where
--    they should have gone in the first place.
WITH ranked AS (
  SELECT id, content, agent_id,
         row_number() OVER (PARTITION BY agent_id, content ORDER BY learned_at, id) AS rn,
         count(*)     OVER (PARTITION BY agent_id, content) AS copies
    FROM agent_memory
   WHERE agent_id IS NULL
),
survivors AS (
  UPDATE agent_memory m
     SET confirmations = m.confirmations + (r.copies - 1),
         confirmed_at  = coalesce(m.confirmed_at, now()),
         updated_at    = now()
    FROM ranked r
   WHERE m.id = r.id AND r.rn = 1 AND r.copies > 1
  RETURNING m.id
)
DELETE FROM agent_memory
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 2. Make NULL agent_id compare equal, so the conflict target actually matches.
ALTER TABLE agent_memory DROP CONSTRAINT agent_memory_agent_id_content_key;
ALTER TABLE agent_memory
  ADD CONSTRAINT agent_memory_agent_id_content_key
  UNIQUE NULLS NOT DISTINCT (agent_id, content);

-- 3. Stop the cap rejecting a re-confirmation.
--
-- The trigger is BEFORE INSERT and fires before ON CONFLICT resolves, so at the
-- cap an agent confirming a fact it already holds was told "memory is full -
-- remove or merge something before adding", when it was not adding anything.
-- Reproduced against a full bucket before writing this. The consequence is that
-- a full store can never be reinforced again, which freezes the ordering signal
-- exactly when the store is most in need of one.
CREATE OR REPLACE FUNCTION enforce_memory_cap() RETURNS trigger AS $$
DECLARE
  v_count integer;
  v_cap   integer;
  v_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM agent_memory
     WHERE content = NEW.content
       AND agent_id IS NOT DISTINCT FROM NEW.agent_id
  ) INTO v_exists;

  -- Already held: this insert will be turned into a confirmation, so it cannot
  -- grow the store and the cap has no business refusing it.
  IF v_exists THEN
    RETURN NEW;
  END IF;

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
$$ LANGUAGE plpgsql;
