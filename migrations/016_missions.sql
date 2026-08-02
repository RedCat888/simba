-- 016_missions.sql
--
-- Missions: durable objectives that outlive any session.
--
-- Everything before this is session-scoped. A real objective — "build an
-- Android app, install whatever toolchain that needs, run it on an emulator and
-- verify it end to end" — spans days, dozens of sessions, several exhausted
-- subscriptions and at least one machine restart. None of that fits in a
-- session, and a session is the wrong unit to hang it on: sessions are
-- deliberately short and disposable.
--
-- A mission is the durable intent. Sessions are how it gets worked on.
--
-- The executor is deterministic: it decides *that* a step should run and picks
-- it up when one is free. Deciding *how* — decomposing the objective, judging
-- whether a step actually succeeded — is model work and is recorded as data so
-- the reasoning survives the session that produced it.

CREATE TABLE missions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                text UNIQUE,
    title               text NOT NULL,

    -- The ask, verbatim. Never paraphrased: it is the contract, and a
    -- summarized objective is how a long-running agent drifts off-target.
    objective           text NOT NULL,

    -- How we know it is done. Written up front, checked at the end. Without
    -- this a mission runs until it runs out of budget rather than until it is
    -- actually finished.
    acceptance_criteria text,

    owner_agent_id      uuid REFERENCES agents(id),
    project_id          uuid REFERENCES projects(id),
    origin_surface_id   uuid REFERENCES surfaces(id),

    status              text NOT NULL DEFAULT 'planning'
                          CHECK (status IN ('planning', 'running', 'blocked', 'verifying',
                                            'completed', 'failed', 'paused', 'cancelled')),

    -- 'continuous' runs until done; a cron expression runs on a schedule and is
    -- how recurring work (watch a repo, maintain a server) is expressed.
    cadence             text NOT NULL DEFAULT 'continuous',
    cron                text,
    next_run_at         timestamptz,

    working_dir         text,

    -- Budget is a stop condition, not a suggestion. An autonomous loop with no
    -- ceiling is the failure mode that turns a runaway agent into a bill.
    max_sessions        int NOT NULL DEFAULT 40,
    sessions_used       int NOT NULL DEFAULT 0,
    max_cost_usd        numeric(10, 4) NOT NULL DEFAULT 25.0,
    cost_used_usd       numeric(12, 6) NOT NULL DEFAULT 0,

    -- Consecutive failures with no progress. Trips the circuit breaker.
    consecutive_failures int NOT NULL DEFAULT 0,
    max_consecutive_failures int NOT NULL DEFAULT 4,

    blocked_reason      text,
    result              text,
    verification        text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    started_at          timestamptz,
    completed_at        timestamptz,
    deadline            timestamptz
);

CREATE INDEX missions_status_idx ON missions (status, next_run_at NULLS FIRST);
CREATE INDEX missions_agent_idx  ON missions (owner_agent_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Steps: the plan, as data.
--
-- Written by the planning session and revisable mid-flight — a mission that
-- discovers it needs a toolchain it did not anticipate must be able to insert
-- steps rather than fail. `kind` distinguishes work that changes the world from
-- work that checks it, because verification must not be skipped when the
-- budget gets tight.
-- ---------------------------------------------------------------------------
CREATE TABLE mission_steps (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mission_id     uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    seq            int NOT NULL,

    title          text NOT NULL,
    instruction    text NOT NULL,
    kind           text NOT NULL DEFAULT 'work'
                     CHECK (kind IN ('research', 'provision', 'work', 'verify', 'report')),

    status         text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'succeeded', 'failed',
                                       'skipped', 'blocked')),

    -- Steps this one needs first. Lets the planner express ordering without the
    -- executor having to infer it.
    depends_on     int[] NOT NULL DEFAULT '{}',

    session_id     uuid REFERENCES sessions(id),
    attempts       int NOT NULL DEFAULT 0,
    max_attempts   int NOT NULL DEFAULT 3,

    result         text,
    error          text,
    -- Preserved per-step so a retry does not repeat the previous attempt's
    -- dead ends, the same reason the checkpoint carries a failure log.
    failures       text,

    created_at     timestamptz NOT NULL DEFAULT now(),
    started_at     timestamptz,
    completed_at   timestamptz,

    UNIQUE (mission_id, seq)
);

CREATE INDEX mission_steps_mission_idx ON mission_steps (mission_id, seq);
CREATE INDEX mission_steps_runnable_idx ON mission_steps (mission_id, status)
    WHERE status IN ('pending', 'running');

-- Append-only narrative of what happened to a mission, separate from the event
-- log so it can be read as a story without filtering.
CREATE TABLE mission_log (
    id          bigserial PRIMARY KEY,
    mission_id  uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    step_id     uuid REFERENCES mission_steps(id) ON DELETE SET NULL,
    ts          timestamptz NOT NULL DEFAULT now(),
    level       text NOT NULL DEFAULT 'info',
    message     text NOT NULL,
    data        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX mission_log_mission_idx ON mission_log (mission_id, ts DESC);

-- ---------------------------------------------------------------------------
-- The next step a mission can actually run.
--
-- A step is runnable when every step it depends on has succeeded. Encoded here
-- rather than in the executor so the scheduling rule is inspectable and the
-- executor stays a loop.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW runnable_steps AS
SELECT s.*
  FROM mission_steps s
  JOIN missions m ON m.id = s.mission_id
 WHERE m.status = 'running'
   AND s.status = 'pending'
   AND s.attempts < s.max_attempts
   AND NOT EXISTS (
       SELECT 1
         FROM unnest(s.depends_on) AS dep(seq)
         JOIN mission_steps d ON d.mission_id = s.mission_id AND d.seq = dep.seq
        WHERE d.status <> 'succeeded'
   );

-- Mission health, for the control center and the periodic brief.
CREATE OR REPLACE VIEW mission_progress AS
SELECT m.id, m.title, m.status, m.cadence, m.sessions_used, m.max_sessions,
       round(m.cost_used_usd, 4) AS cost_used, m.max_cost_usd,
       m.consecutive_failures, m.blocked_reason, m.created_at, m.updated_at,
       a.slug AS agent,
       count(s.id)::int                                        AS total_steps,
       count(s.id) FILTER (WHERE s.status = 'succeeded')::int   AS done_steps,
       count(s.id) FILTER (WHERE s.status = 'failed')::int      AS failed_steps,
       (SELECT s2.title FROM mission_steps s2
         WHERE s2.mission_id = m.id AND s2.status = 'running'
         ORDER BY s2.seq LIMIT 1)                               AS current_step
  FROM missions m
  LEFT JOIN agents a ON a.id = m.owner_agent_id
  LEFT JOIN mission_steps s ON s.mission_id = m.id
 GROUP BY m.id, a.slug;
