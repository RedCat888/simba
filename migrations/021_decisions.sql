-- 021_decisions.sql
--
-- Decisions as first-class rows.
--
-- The corpus holds ~30k chunks of conversation, and semantic search over it
-- returns the *deliberation* — the arguing, the options, the thinking-aloud.
-- What is actually wanted from "what did I decide about X" is the conclusion,
-- and critically whether it still stands: a position reached in March and
-- reversed in June is worse than useless if only the March discussion surfaces.
--
-- So decisions are extracted, dated, linked to their source, and allowed to
-- supersede one another. The answer to a question becomes "here is the current
-- position, and here is what it replaced".

CREATE TABLE decisions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The conclusion itself, stated as a claim rather than a summary of a
    -- conversation. "Use Postgres over SQLite" — not "discussed databases".
    statement      text NOT NULL,
    rationale      text,
    topic          text,
    tags           text[] NOT NULL DEFAULT '{}',

    -- How firm it was. A decision reached and acted on carries more weight than
    -- one leaned toward mid-conversation, and conflating them makes the whole
    -- store untrustworthy.
    confidence     text NOT NULL DEFAULT 'stated'
                     CHECK (confidence IN ('acted_on', 'decided', 'stated', 'considered')),

    decided_at     timestamptz,

    source_item_id uuid REFERENCES knowledge_items(id) ON DELETE SET NULL,
    source_kind    text,
    source_excerpt text,

    -- Supersession, which is the entire point of storing these separately.
    superseded_by  uuid REFERENCES decisions(id),
    superseded_at  timestamptz,
    status         text NOT NULL DEFAULT 'current'
                     CHECK (status IN ('current', 'superseded', 'abandoned')),

    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX decisions_current_idx ON decisions (decided_at DESC) WHERE status = 'current';
CREATE INDEX decisions_topic_idx ON decisions (topic);
CREATE INDEX decisions_tags_idx ON decisions USING gin (tags);
CREATE INDEX decisions_statement_trgm_idx ON decisions USING gin (statement gin_trgm_ops);

-- Extraction bookkeeping, so a run over ~8k items can be resumed after an
-- interruption instead of restarted.
CREATE TABLE decision_extractions (
    item_id      uuid PRIMARY KEY REFERENCES knowledge_items(id) ON DELETE CASCADE,
    extracted_at timestamptz NOT NULL DEFAULT now(),
    found        int NOT NULL DEFAULT 0,
    model        text
);

ALTER TABLE embeddings DROP CONSTRAINT IF EXISTS embeddings_owner_kind_check;
ALTER TABLE embeddings ADD CONSTRAINT embeddings_owner_kind_check
    CHECK (owner_kind IN ('knowledge_chunk', 'message', 'summary',
                          'document_revision', 'checkpoint', 'agent_brief', 'decision'));

-- Current positions with what they replaced, which is the shape a question
-- about a past decision actually wants back.
CREATE OR REPLACE VIEW current_decisions AS
SELECT d.id, d.statement, d.rationale, d.topic, d.tags, d.confidence,
       d.decided_at, d.source_kind, d.source_excerpt,
       (SELECT count(*)::int FROM decisions p WHERE p.superseded_by = d.id) AS replaced_count
  FROM decisions d
 WHERE d.status = 'current';
