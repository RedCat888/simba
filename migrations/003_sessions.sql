-- 003_sessions.sql
-- Sessions, turns, transcripts, and the checkpoint artifact that makes a
-- session portable across brains.
--
-- Granularity note: cost, tokens and brain identity live on `turns`, not on
-- `sessions`. The moment failover works a single session has been executed by
-- more than one brain, so anything charged per-brain has to hang off the turn.

-- ---------------------------------------------------------------------------
-- Sessions: one bounded run of one CLI under one agent. Short and disposable
-- by design. `hydrated_from_session_id` records the lineage when a session is
-- a continuation rather than a fresh start.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id                 uuid NOT NULL REFERENCES agents(id),

    -- The CLI's own session identifier, used for native --resume. Null until
    -- the tool reports one.
    native_session_id        text,
    cli                      text NOT NULL,
    brain_account_id         uuid REFERENCES brain_accounts(id),
    node_id                  uuid REFERENCES nodes(id),
    project_id               uuid REFERENCES projects(id),

    worktree_path            text,
    branch                   text,
    cwd                      text,

    status                   text NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'running', 'idle', 'sleeping',
                                                 'waiting_limit', 'completed', 'failed',
                                                 'superseded', 'killed')),

    -- Continuation lineage. A rehydrated session points back at the session it
    -- continues and at the checkpoint used to seed it.
    hydrated_from_session_id uuid REFERENCES sessions(id),
    hydrated_from_checkpoint uuid,
    swap_count               int NOT NULL DEFAULT 0,

    title                    text,
    description              text,
    tags                     text[] NOT NULL DEFAULT '{}',

    total_cost_usd           numeric(12, 6) NOT NULL DEFAULT 0,
    total_input_tokens       bigint NOT NULL DEFAULT 0,
    total_output_tokens      bigint NOT NULL DEFAULT 0,

    error                    text,
    started_at               timestamptz,
    ended_at                 timestamptz,
    last_activity_at         timestamptz,
    created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_agent_idx ON sessions (agent_id, created_at DESC);
CREATE INDEX sessions_active_idx ON sessions (status, last_activity_at DESC)
    WHERE status IN ('running', 'idle', 'waiting_limit', 'sleeping');
CREATE INDEX sessions_native_idx ON sessions (cli, native_session_id)
    WHERE native_session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Turns: one request/response cycle. The unit at which a brain is chosen and
-- at which usage is attributed.
-- ---------------------------------------------------------------------------
CREATE TABLE turns (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id            uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq                   int NOT NULL,
    brain_account_id      uuid REFERENCES brain_accounts(id),
    model                 text,
    model_tier            text,

    status                text NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running', 'completed', 'failed',
                                              'limited', 'interrupted', 'steered')),

    input_tokens          bigint NOT NULL DEFAULT 0,
    output_tokens         bigint NOT NULL DEFAULT 0,
    cache_read_tokens     bigint NOT NULL DEFAULT 0,
    cache_creation_tokens bigint NOT NULL DEFAULT 0,
    cost_usd              numeric(12, 6) NOT NULL DEFAULT 0,

    stop_reason           text,
    error                 text,
    started_at            timestamptz NOT NULL DEFAULT now(),
    ended_at              timestamptz,
    duration_ms           int,

    UNIQUE (session_id, seq)
);

CREATE INDEX turns_brain_idx ON turns (brain_account_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- Messages. Partitioned monthly: transcripts are the highest-volume table and
-- retention/vacuum is far cheaper per-partition.
--
-- `raw` holds the provider payload verbatim. Normalization is for querying;
-- the raw column is what lets us re-derive when the normalizer turns out to
-- have been lossy, which it will.
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
    id         uuid NOT NULL DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL,
    turn_id    uuid,
    agent_id   uuid,
    seq        bigint NOT NULL,
    role       text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content    text,
    reasoning  text,
    raw        jsonb,
    tokens     int,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX messages_session_idx ON messages (session_id, seq);
CREATE INDEX messages_agent_idx ON messages (agent_id, created_at DESC);
CREATE INDEX messages_content_trgm_idx ON messages USING gin (content gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Tool calls. Same partitioning rationale.
-- ---------------------------------------------------------------------------
CREATE TABLE tool_calls (
    id          uuid NOT NULL DEFAULT gen_random_uuid(),
    session_id  uuid NOT NULL,
    turn_id     uuid,
    agent_id    uuid,
    message_id  uuid,
    tool_use_id text,
    name        text NOT NULL,
    args        jsonb,
    result      jsonb,
    result_text text,
    is_error    boolean NOT NULL DEFAULT false,
    error       text,
    duration_ms int,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX tool_calls_session_idx ON tool_calls (session_id, created_at);
CREATE INDEX tool_calls_name_idx ON tool_calls (name, created_at DESC);
CREATE INDEX tool_calls_errors_idx ON tool_calls (agent_id, created_at DESC) WHERE is_error;

-- ---------------------------------------------------------------------------
-- Checkpoints: the handoff artifact.
--
-- This is what a receiving brain reads, not the raw transcript. Written every
-- turn so that a limit hit detected *after* the fact still has something
-- current to hand over. `failures` is the highest-value field — without it a
-- rehydrated agent re-walks every dead end its predecessor already found.
-- ---------------------------------------------------------------------------
CREATE TABLE checkpoints (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_id        uuid NOT NULL REFERENCES agents(id),
    turn_id         uuid REFERENCES turns(id),

    reason          text NOT NULL
                      CHECK (reason IN ('periodic', 'limit_hit', 'brain_swap', 'manual',
                                        'session_end', 'crash', 'context_full', 'handoff')),

    task_statement  text,
    work_done       text,
    work_remaining  text,
    failures        text,
    key_decisions   text,
    open_questions  text,

    git_branch      text,
    git_head        text,
    git_dirty       boolean,
    git_diffstat    text,
    recent_files    text[],

    raw_context     jsonb,
    token_estimate  int,
    generated_by    text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX checkpoints_session_idx ON checkpoints (session_id, created_at DESC);
CREATE INDEX checkpoints_agent_idx ON checkpoints (agent_id, created_at DESC);

ALTER TABLE sessions
    ADD CONSTRAINT sessions_hydrated_checkpoint_fkey
    FOREIGN KEY (hydrated_from_checkpoint) REFERENCES checkpoints(id);

-- ---------------------------------------------------------------------------
-- Monthly partition management. A DEFAULT partition keeps inserts from ever
-- failing; the maintenance job pre-creates the coming months so rows normally
-- land in a real partition.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ensure_month_partition(p_table text, p_month date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_start date := date_trunc('month', p_month)::date;
    v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
    v_name  text := format('%s_p%s', p_table, to_char(v_start, 'YYYYMM'));
BEGIN
    IF to_regclass(v_name) IS NULL THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
            v_name, p_table, v_start, v_end
        );
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION ensure_partitions(p_months_ahead int DEFAULT 3)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    t text;
    i int;
BEGIN
    FOREACH t IN ARRAY ARRAY['messages', 'tool_calls'] LOOP
        FOR i IN -1 .. p_months_ahead LOOP
            PERFORM ensure_month_partition(t, (current_date + (i || ' months')::interval)::date);
        END LOOP;
    END LOOP;
END;
$$;

CREATE TABLE messages_default PARTITION OF messages DEFAULT;
CREATE TABLE tool_calls_default PARTITION OF tool_calls DEFAULT;

SELECT ensure_partitions(6);
