-- 002_core.sql
-- The roster and the things it references. Everything here is configuration
-- expressed as data: adding an agent or a brain is an INSERT, never a code edit.

-- ---------------------------------------------------------------------------
-- Nodes: machines Simba can reach. The Windows PC is authoritative; the
-- MacBook is a peer that may be absent, so nothing may hard-depend on it.
-- ---------------------------------------------------------------------------
CREATE TABLE nodes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug          text NOT NULL UNIQUE,
    name          text NOT NULL,
    platform      text NOT NULL CHECK (platform IN ('windows', 'darwin', 'linux')),
    hostname      text,
    is_primary    boolean NOT NULL DEFAULT false,
    status        text NOT NULL DEFAULT 'offline'
                    CHECK (status IN ('online', 'offline', 'sleeping', 'unreachable')),
    capabilities  jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_seen_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Brain accounts: one row per subscription (or, later, per API key). This is
-- the identity that usage is charged against and that failover rotates through.
--
-- config_dir is the isolation mechanism: CLAUDE_CONFIG_DIR for Claude Code,
-- CODEX_HOME for Codex. Two rows with different config_dir values are two
-- fully separate logins on the same machine.
-- ---------------------------------------------------------------------------
CREATE TABLE brain_accounts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            text NOT NULL UNIQUE,
    label           text NOT NULL,
    provider        text NOT NULL CHECK (provider IN ('anthropic', 'openai', 'cursor', 'google', 'local')),
    kind            text NOT NULL DEFAULT 'subscription'
                      CHECK (kind IN ('subscription', 'api_key')),
    cli             text NOT NULL,
    config_dir      text,
    env             jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- Which concrete model to use at each tier. Simba picks the tier; this
    -- table resolves the tier to a model string for the chosen provider.
    tier_models     jsonb NOT NULL DEFAULT '{}'::jsonb,

    priority        int NOT NULL DEFAULT 100,
    enabled         boolean NOT NULL DEFAULT true,
    status          text NOT NULL DEFAULT 'unverified'
                      CHECK (status IN ('available', 'limited', 'error', 'logged_out', 'unverified')),

    -- Set from the reset timestamp the CLI reports when it refuses a turn.
    -- The supervisor schedules a wake-up against this.
    limit_resets_at timestamptz,
    last_checked_at timestamptz,
    last_error      text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX brain_accounts_available_idx
    ON brain_accounts (priority)
    WHERE enabled AND status = 'available';

-- ---------------------------------------------------------------------------
-- Projects: a durable scope an agent can own. Not every project is a git repo
-- (local-only work, infrastructure, a game server all qualify).
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            text NOT NULL UNIQUE,
    name            text NOT NULL,
    kind            text NOT NULL DEFAULT 'repo'
                      CHECK (kind IN ('repo', 'local', 'infra', 'domain', 'account')),
    root_path       text,
    git_remote      text,
    default_branch  text DEFAULT 'main',
    node_id         uuid REFERENCES nodes(id),
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    archived        boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Permission profiles. Default posture is bypass-everything; the deny list is
-- the short set of genuinely unrecoverable operations, enforced at the runner
-- rather than by asking the model to behave.
-- ---------------------------------------------------------------------------
CREATE TABLE permission_profiles (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug              text NOT NULL UNIQUE,
    name              text NOT NULL,
    bypass_all        boolean NOT NULL DEFAULT true,

    -- Hard stop. The runner refuses and asks the operator.
    deny_patterns     text[] NOT NULL DEFAULT '{}',
    -- Allowed, but a phone confirmation is required first.
    confirm_patterns  text[] NOT NULL DEFAULT '{}',

    allowed_tools     text[],
    allowed_mcp       text[],
    credential_scopes jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Agents: durable identity, not a running process. An agent outlives every
-- session it spawns; continuity comes from this row plus the hydration bundle,
-- never from a long-lived context window.
-- ---------------------------------------------------------------------------
CREATE TABLE agents (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                  text NOT NULL UNIQUE,
    name                  text NOT NULL,
    tier                  smallint NOT NULL CHECK (tier IN (0, 1, 2)),
    domain                text,
    description           text,

    project_id            uuid REFERENCES projects(id),
    node_id               uuid REFERENCES nodes(id),
    parent_agent_id       uuid REFERENCES agents(id),

    preferred_cli         text,
    model_tier            text NOT NULL DEFAULT 'high'
                            CHECK (model_tier IN ('high', 'mid', 'cheap')),
    -- Ordered fallback chain of brain_accounts.id. Empty means "use the
    -- routing policy that matches this agent's tier".
    brain_chain           uuid[] NOT NULL DEFAULT '{}',

    permission_profile_id uuid REFERENCES permission_profiles(id),

    status                text NOT NULL DEFAULT 'idle'
                            CHECK (status IN ('idle', 'running', 'sleeping', 'waiting_limit', 'error', 'retired')),

    -- The agent's persistent self-description, regenerated rather than
    -- hand-edited. Materialized to CLAUDE.md / AGENTS.md at session start.
    standing_brief        text,

    budget                jsonb NOT NULL DEFAULT '{}'::jsonb,
    config                jsonb NOT NULL DEFAULT '{}'::jsonb,

    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    last_active_at        timestamptz,
    retired_at            timestamptz
);

CREATE INDEX agents_tier_status_idx ON agents (tier, status) WHERE retired_at IS NULL;
CREATE INDEX agents_project_idx ON agents (project_id) WHERE retired_at IS NULL;

-- ---------------------------------------------------------------------------
-- Routing policy as data. Resolution order: agent.brain_chain, then the
-- highest-priority policy whose scope matches, then global default.
-- ---------------------------------------------------------------------------
CREATE TABLE routing_policies (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                 text NOT NULL UNIQUE,
    name                 text NOT NULL,
    applies_to_tier      smallint,
    applies_to_agent_id  uuid REFERENCES agents(id),
    model_tier           text CHECK (model_tier IN ('high', 'mid', 'cheap')),
    brain_chain          uuid[] NOT NULL DEFAULT '{}',

    -- What to do when every brain in the chain is exhausted.
    on_exhausted         text NOT NULL DEFAULT 'sleep_until_reset'
                           CHECK (on_exhausted IN ('sleep_until_reset', 'escalate', 'stop')),
    max_swaps_per_session int NOT NULL DEFAULT 6,
    enabled              boolean NOT NULL DEFAULT true,
    priority             int NOT NULL DEFAULT 100,
    created_at           timestamptz NOT NULL DEFAULT now()
);
