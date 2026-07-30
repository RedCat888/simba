-- 004_collab.sql
-- Shared documents, the audit log, inter-agent inboxes, artifacts, summaries,
-- and usage accounting.

-- ---------------------------------------------------------------------------
-- Documents replace every SPEC.md / AGENTS.md / HANDOFF.md. Agents collaborate
-- through these rows. CLAUDE.md and AGENTS.md on disk are regenerated
-- projections of a document row and are never read back after a session ends.
-- ---------------------------------------------------------------------------
CREATE TABLE documents (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug             text NOT NULL,
    kind             text NOT NULL DEFAULT 'note'
                       CHECK (kind IN ('note', 'spec', 'brief', 'plan', 'decision',
                                       'inventory', 'analysis', 'runbook')),
    scope            text NOT NULL DEFAULT 'global'
                       CHECK (scope IN ('global', 'agent', 'project', 'session')),

    agent_id         uuid REFERENCES agents(id),
    project_id       uuid REFERENCES projects(id),
    session_id       uuid REFERENCES sessions(id),

    title            text,
    current_revision int NOT NULL DEFAULT 0,
    archived         boolean NOT NULL DEFAULT false,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Slug is unique within its scope. Coalesced keys keep the uniqueness check
-- working when the scope-owning column is null.
CREATE UNIQUE INDEX documents_scope_slug_idx ON documents (
    scope,
    slug,
    coalesce(agent_id,   '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

CREATE TABLE document_revisions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id       uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    revision          int NOT NULL,
    content           text NOT NULL,
    summary           text,
    author_agent_id   uuid REFERENCES agents(id),
    author_session_id uuid REFERENCES sessions(id),
    author_turn_id    uuid REFERENCES turns(id),
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (document_id, revision)
);

CREATE INDEX document_revisions_doc_idx ON document_revisions (document_id, revision DESC);

-- ---------------------------------------------------------------------------
-- Append-only audit log. Never updated, never deleted outside retention.
-- Every spawn, wake, sleep, crash, restart, brain swap and merge lands here.
-- ---------------------------------------------------------------------------
CREATE TABLE events (
    id               bigserial PRIMARY KEY,
    ts               timestamptz NOT NULL DEFAULT now(),
    type             text NOT NULL,
    severity         text NOT NULL DEFAULT 'info'
                       CHECK (severity IN ('debug', 'info', 'warn', 'error', 'critical')),
    agent_id         uuid,
    session_id       uuid,
    turn_id          uuid,
    brain_account_id uuid,
    node_id          uuid,
    message          text,
    data             jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX events_ts_idx ON events (ts DESC);
CREATE INDEX events_type_idx ON events (type, ts DESC);
CREATE INDEX events_agent_idx ON events (agent_id, ts DESC);
CREATE INDEX events_severity_idx ON events (severity, ts DESC)
    WHERE severity IN ('warn', 'error', 'critical');

-- ---------------------------------------------------------------------------
-- Inter-agent inboxes. Messages queue here for agents that are asleep.
--
-- hop_count and correlation_id are what the router uses to break loops: a
-- chain that exceeds the hop limit, or revisits a pair it has already been
-- through, escalates instead of retrying.
-- ---------------------------------------------------------------------------
CREATE TABLE inboxes (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_agent_id     uuid REFERENCES agents(id),
    to_agent_id       uuid NOT NULL REFERENCES agents(id),

    intent            text NOT NULL,
    payload           jsonb NOT NULL DEFAULT '{}'::jsonb,

    correlation_id    uuid NOT NULL DEFAULT gen_random_uuid(),
    parent_message_id uuid REFERENCES inboxes(id),
    hop_count         int NOT NULL DEFAULT 0,
    ttl_seconds       int,

    status            text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'delivered', 'answered', 'expired',
                                          'escalated', 'dropped')),
    priority          int NOT NULL DEFAULT 100,
    wake_target       boolean NOT NULL DEFAULT false,

    response          jsonb,
    escalation_reason text,

    created_at        timestamptz NOT NULL DEFAULT now(),
    delivered_at      timestamptz,
    answered_at       timestamptz,
    expires_at        timestamptz
);

CREATE INDEX inboxes_pending_idx ON inboxes (to_agent_id, priority, created_at)
    WHERE status = 'pending';
CREATE INDEX inboxes_correlation_idx ON inboxes (correlation_id, created_at);

-- ---------------------------------------------------------------------------
-- Artifacts: things a session produced that outlive it.
-- ---------------------------------------------------------------------------
CREATE TABLE artifacts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  uuid REFERENCES sessions(id),
    agent_id    uuid REFERENCES agents(id),
    project_id  uuid REFERENCES projects(id),
    kind        text NOT NULL
                  CHECK (kind IN ('file', 'pr', 'commit', 'branch', 'deployment',
                                  'intake_item', 'media', 'report', 'external')),
    title       text,
    description text,
    uri         text,
    path        text,
    external_id text,
    status      text,
    data        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX artifacts_session_idx ON artifacts (session_id, created_at DESC);
CREATE INDEX artifacts_kind_idx ON artifacts (kind, created_at DESC);

-- ---------------------------------------------------------------------------
-- Auto-generated titles, descriptions and tags. Always produced by a cheap
-- model; nothing here justifies a high-tier brain.
-- ---------------------------------------------------------------------------
CREATE TABLE summaries (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope       text NOT NULL DEFAULT 'session'
                  CHECK (scope IN ('session', 'agent', 'turn_range', 'day')),
    session_id  uuid REFERENCES sessions(id) ON DELETE CASCADE,
    agent_id    uuid REFERENCES agents(id),
    title       text,
    description text,
    tags        text[] NOT NULL DEFAULT '{}',
    summary     text,
    covers_from timestamptz,
    covers_to   timestamptz,
    model       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX summaries_session_idx ON summaries (session_id, created_at DESC);
CREATE INDEX summaries_agent_idx ON summaries (agent_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Usage, attributed per brain account. This is the table the supervisor reads
-- to decide a subscription is close to its limit before the CLI says so.
-- ---------------------------------------------------------------------------
CREATE TABLE usage (
    id                    bigserial PRIMARY KEY,
    brain_account_id      uuid NOT NULL REFERENCES brain_accounts(id),
    agent_id              uuid REFERENCES agents(id),
    session_id            uuid REFERENCES sessions(id),
    turn_id               uuid REFERENCES turns(id),
    model                 text,
    input_tokens          bigint NOT NULL DEFAULT 0,
    output_tokens         bigint NOT NULL DEFAULT 0,
    cache_read_tokens     bigint NOT NULL DEFAULT 0,
    cache_creation_tokens bigint NOT NULL DEFAULT 0,
    cost_usd              numeric(12, 6) NOT NULL DEFAULT 0,
    recorded_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX usage_brain_time_idx ON usage (brain_account_id, recorded_at DESC);

-- Rolling-window consumption per brain. The supervisor's cheap pre-check
-- before dispatching a turn.
CREATE OR REPLACE VIEW usage_windows AS
SELECT
    b.id   AS brain_account_id,
    b.slug,
    b.status,
    b.limit_resets_at,
    coalesce(sum(u.input_tokens)  FILTER (WHERE u.recorded_at > now() - interval '5 hours'), 0)  AS input_5h,
    coalesce(sum(u.output_tokens) FILTER (WHERE u.recorded_at > now() - interval '5 hours'), 0)  AS output_5h,
    coalesce(sum(u.cost_usd)      FILTER (WHERE u.recorded_at > now() - interval '5 hours'), 0)  AS cost_5h,
    coalesce(sum(u.input_tokens)  FILTER (WHERE u.recorded_at > now() - interval '7 days'), 0)   AS input_7d,
    coalesce(sum(u.output_tokens) FILTER (WHERE u.recorded_at > now() - interval '7 days'), 0)   AS output_7d,
    coalesce(sum(u.cost_usd)      FILTER (WHERE u.recorded_at > now() - interval '7 days'), 0)   AS cost_7d
FROM brain_accounts b
LEFT JOIN usage u ON u.brain_account_id = b.id
GROUP BY b.id, b.slug, b.status, b.limit_resets_at;
