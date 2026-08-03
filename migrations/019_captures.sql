-- 019_captures.sql
--
-- The capture inbox: anything shared into Simba from anywhere.
--
-- Separate from `inboxes` (agent-to-agent) and from `artifacts` (things a
-- session produced) because this is neither — it is unprocessed input from the
-- outside world, arriving faster than it gets triaged, and it needs its own
-- lifecycle. Instagram intake, the Android share sheet, webhooks and pasted
-- links all land here.
--
-- Content is untrusted by construction: it comes from whatever the user was
-- looking at. Triage classifies it; it never executes it.

CREATE TABLE captures (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    source          text NOT NULL,
    content         text NOT NULL,
    url             text,
    media_uri       text,

    -- Filled by triage, not by the sender.
    kind            text CHECK (kind IN ('repo', 'article', 'video', 'task', 'idea',
                                         'reference', 'contact', 'purchase', 'unknown')),
    title           text,
    summary         text,
    tags            text[] NOT NULL DEFAULT '{}',

    status          text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'triaged', 'routed', 'done',
                                        'rejected', 'failed')),

    -- Where it went, if anywhere.
    routed_agent_id uuid REFERENCES agents(id),
    mission_id      uuid REFERENCES missions(id),
    session_id      uuid REFERENCES sessions(id),

    origin_surface_id uuid REFERENCES surfaces(id),
    note            text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    triaged_at      timestamptz,
    resolved_at     timestamptz
);

CREATE INDEX captures_pending_idx ON captures (created_at DESC) WHERE status = 'pending';
CREATE INDEX captures_source_idx  ON captures (source, created_at DESC);
CREATE INDEX captures_content_trgm_idx ON captures USING gin (content gin_trgm_ops);
