-- 015_surfaces.sql
--
-- Surfaces: authority scoped by where a request came from, not just by which
-- agent handles it.
--
-- The existing permission model answers "what may this agent do". Once the
-- gateway is reachable from a phone that is no longer sufficient, because the
-- same agent is now reachable through a channel with a very different risk
-- profile. A stolen phone session, a shared device, or a browser cookie should
-- not carry the same authority as a keyboard physically attached to the machine
-- that holds the credentials.
--
-- The deny-list protects Windows from destroying itself. It does nothing about
-- identity, money, private data, or irreversible external actions — those are
-- what surfaces bound.
--
-- Design rule: authority is the INTERSECTION of the agent's permission profile
-- and the originating surface's policy. Neither can widen the other.

CREATE TABLE surfaces (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                    text NOT NULL UNIQUE,
    name                    text NOT NULL,
    description             text,

    -- Advisory ordering, useful for display and for "at least as trusted as".
    trust_level             int NOT NULL DEFAULT 50,

    -- Action classes that may ORIGINATE here at all. Empty means none.
    allowed_action_classes  text[] NOT NULL DEFAULT '{}',
    -- Classes allowed but requiring an explicit confirmation before they run.
    confirm_action_classes  text[] NOT NULL DEFAULT '{}',

    -- Ceiling on model tier, so a low-trust surface cannot burn the expensive
    -- brains even if the agent it addresses is configured for them.
    max_model_tier          text NOT NULL DEFAULT 'high'
                              CHECK (max_model_tier IN ('high', 'mid', 'cheap', 'free')),

    can_spawn_agents        boolean NOT NULL DEFAULT true,
    can_modify_roster       boolean NOT NULL DEFAULT false,
    can_panic               boolean NOT NULL DEFAULT true,

    -- Null means every agent. A list restricts which agents are reachable.
    allowed_agent_slugs     text[],
    denied_agent_slugs      text[] NOT NULL DEFAULT '{}',

    max_concurrent_sessions int NOT NULL DEFAULT 10,
    enabled                 boolean NOT NULL DEFAULT true,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sessions ADD COLUMN origin_surface_id uuid REFERENCES surfaces(id);
ALTER TABLE actions  ADD COLUMN origin_surface_id uuid REFERENCES surfaces(id);

CREATE INDEX sessions_surface_idx ON sessions (origin_surface_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- The four surfaces that exist today.
-- ---------------------------------------------------------------------------

-- Physical access to the machine already implies full control, so bounding it
-- would be theatre rather than security.
INSERT INTO surfaces (slug, name, description, trust_level,
                      allowed_action_classes, confirm_action_classes,
                      max_model_tier, can_spawn_agents, can_modify_roster, can_panic)
VALUES ('desktop', 'Windows desktop (local)',
        'Requests originating on the machine itself, over loopback.', 100,
        ARRAY['send','publish','deploy','purchase','delete','external_write','dns','billing'],
        ARRAY[]::text[], 'high', true, true, true);

-- The phone is the surface most likely to be lost, stolen, or left unlocked,
-- and it reaches the system over the public internet. It gets full read access
-- and full ability to direct work, but anything that spends money, changes DNS,
-- or destroys data has to be confirmed rather than merely requested.
INSERT INTO surfaces (slug, name, description, trust_level,
                      allowed_action_classes, confirm_action_classes,
                      max_model_tier, can_spawn_agents, can_modify_roster, can_panic)
VALUES ('phone', 'Galaxy S24 (via Cloudflare Access)',
        'Remote control from the phone. Reaches the gateway through the tunnel.', 60,
        ARRAY['send','publish','deploy','external_write','delete'],
        ARRAY['delete','deploy','publish'],
        'high', true, false, true);

-- Not yet paired. Seeded disabled so it cannot be assumed into existence: a
-- surface that appears without being deliberately enabled is exactly the kind
-- of quiet authority expansion this table is meant to prevent.
INSERT INTO surfaces (slug, name, description, trust_level,
                      allowed_action_classes, confirm_action_classes,
                      max_model_tier, can_spawn_agents, can_modify_roster, enabled)
VALUES ('macbook', 'MacBook Air M4 (paired node)',
        'Mac-only work. Disabled until the node is actually paired.', 70,
        ARRAY['send','publish','external_write'],
        ARRAY['delete','deploy'],
        'high', true, false, false);

-- Inbound automation: webhooks, Instagram intake, cron. Content arriving here
-- is attacker-influenceable, so it may direct work but may not itself cause an
-- irreversible external effect.
INSERT INTO surfaces (slug, name, description, trust_level,
                      allowed_action_classes, confirm_action_classes,
                      max_model_tier, can_spawn_agents, can_modify_roster, can_panic,
                      denied_agent_slugs, max_concurrent_sessions)
VALUES ('automation', 'Webhooks, intake and cron',
        'Untrusted inbound triggers. May queue and analyse; may not act outward unattended.', 20,
        ARRAY['external_write'],
        ARRAY['send','publish','deploy','delete'],
        'mid', true, false, false,
        ARRAY['windows-admin']::text[], 4);

-- Convenience view for the control center.
CREATE OR REPLACE VIEW surface_activity AS
SELECT sf.slug, sf.name, sf.trust_level, sf.enabled, sf.max_model_tier,
       count(s.id) FILTER (WHERE s.status IN ('running','idle'))::int AS active_sessions,
       count(s.id)::int                                               AS total_sessions,
       count(a.id) FILTER (WHERE a.status = 'needs_confirmation')::int AS awaiting_confirmation
  FROM surfaces sf
  LEFT JOIN sessions s ON s.origin_surface_id = sf.id
  LEFT JOIN actions  a ON a.origin_surface_id = sf.id
 GROUP BY sf.id, sf.slug, sf.name, sf.trust_level, sf.enabled, sf.max_model_tier;
