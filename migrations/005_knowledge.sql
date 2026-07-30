-- 005_knowledge.sql
-- The local vector store: ChatGPT/Claude chat exports, the Obsidian vault, the
-- existing knowledge API corpus, and semantic recall over Simba's own history.
--
-- Embedding dimension is fixed at 768 to match nomic-embed-text served locally
-- by Ollama. That keeps the vector store consistent with the rest of the
-- system's no-API-key posture: embedding a few hundred thousand chunks through
-- a hosted endpoint would need a key and would cost money, and local embedding
-- quality is more than sufficient for recall over personal history.
--
-- Changing embedding model means changing this dimension, which means a
-- rebuild. `embeddings.model` records which model produced each row so a
-- migration can proceed incrementally rather than all at once.

-- ---------------------------------------------------------------------------
-- Where a body of knowledge came from.
-- ---------------------------------------------------------------------------
CREATE TABLE knowledge_sources (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug             text NOT NULL UNIQUE,
    kind             text NOT NULL
                       CHECK (kind IN ('chatgpt_export', 'claude_export', 'obsidian',
                                       'knowledge_api', 'repo', 'manual', 'session_history')),
    name             text NOT NULL,
    uri              text,
    config           jsonb NOT NULL DEFAULT '{}'::jsonb,
    item_count       int NOT NULL DEFAULT 0,
    last_ingested_at timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- One row per source document: a conversation, a vault note, a knowledge-API
-- item. content_hash makes re-ingest idempotent so the pipeline can be run
-- repeatedly against a growing export directory.
-- ---------------------------------------------------------------------------
CREATE TABLE knowledge_items (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id         uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
    external_id       text,
    title             text,
    content           text NOT NULL,
    category          text,
    tags              text[] NOT NULL DEFAULT '{}',
    metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
    content_hash      text NOT NULL,
    source_created_at timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_id, external_id)
);

CREATE INDEX knowledge_items_source_idx ON knowledge_items (source_id, source_created_at DESC);
CREATE INDEX knowledge_items_hash_idx ON knowledge_items (content_hash);
CREATE INDEX knowledge_items_content_trgm_idx ON knowledge_items USING gin (content gin_trgm_ops);
CREATE INDEX knowledge_items_tags_idx ON knowledge_items USING gin (tags);

-- ---------------------------------------------------------------------------
-- Chunks are what actually get embedded.
-- ---------------------------------------------------------------------------
CREATE TABLE knowledge_chunks (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id     uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    chunk_index int NOT NULL,
    content     text NOT NULL,
    token_count int,
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (item_id, chunk_index)
);

CREATE INDEX knowledge_chunks_item_idx ON knowledge_chunks (item_id, chunk_index);

-- ---------------------------------------------------------------------------
-- One embeddings table for every embeddable thing, discriminated by owner_kind.
-- Semantic recall over an agent's own history and recall over the personal
-- knowledge corpus are the same query against the same index.
-- ---------------------------------------------------------------------------
CREATE TABLE embeddings (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_kind   text NOT NULL
                   CHECK (owner_kind IN ('knowledge_chunk', 'message', 'summary',
                                         'document_revision', 'checkpoint', 'agent_brief')),
    owner_id     uuid NOT NULL,
    agent_id     uuid REFERENCES agents(id),
    model        text NOT NULL DEFAULT 'nomic-embed-text',
    dim          int NOT NULL DEFAULT 768,
    embedding    vector(768) NOT NULL,
    content_hash text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_kind, owner_id, model)
);

-- HNSW over cosine distance. Built after the first bulk ingest rather than
-- before it; creating it up front makes the initial load substantially slower.
CREATE INDEX embeddings_hnsw_idx ON embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX embeddings_owner_idx ON embeddings (owner_kind, owner_id);
CREATE INDEX embeddings_agent_idx ON embeddings (agent_id) WHERE agent_id IS NOT NULL;

-- Convenience view: chunk text joined to its embedding and provenance, which
-- is what every recall query actually wants.
CREATE OR REPLACE VIEW knowledge_search_view AS
SELECT
    e.id           AS embedding_id,
    e.embedding,
    e.owner_kind,
    e.owner_id,
    c.content      AS chunk_content,
    c.chunk_index,
    i.id           AS item_id,
    i.title,
    i.category,
    i.tags,
    i.source_created_at,
    s.slug         AS source_slug,
    s.kind         AS source_kind
FROM embeddings e
JOIN knowledge_chunks c  ON c.id = e.owner_id AND e.owner_kind = 'knowledge_chunk'
JOIN knowledge_items i   ON i.id = c.item_id
JOIN knowledge_sources s ON s.id = i.source_id;
