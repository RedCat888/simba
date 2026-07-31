-- 012_action_ledger.sql
--
-- The action ledger, added in response to a specific architectural gap: the
-- system now has three independent mechanisms that can re-run work — brain
-- failover, park-and-auto-resume, and session revival — and nothing that makes
-- an external side effect safe to attempt twice.
--
-- An append-only audit log explains after the fact why something happened. It
-- does not prevent a message being sent twice, a deployment being triggered
-- again on resume, or two nodes acting on the same task. Those need an
-- idempotency key claimed *before* the effect and a receipt recorded after.
--
-- Scope is deliberately external effects only. Reading files, running tests and
-- editing a worktree are all safely repeatable; sending, publishing, deploying,
-- purchasing and deleting are not.

CREATE TABLE actions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Caller-supplied and unique. Deriving it from the intent (rather than
    -- randomly) is what makes a retry after a crash collapse onto the same row
    -- instead of creating a second one.
    idempotency_key  text NOT NULL UNIQUE,

    agent_id         uuid REFERENCES agents(id),
    session_id       uuid REFERENCES sessions(id),
    turn_id          uuid REFERENCES turns(id),

    -- Coarse class, used for policy: which actions need confirmation, which are
    -- freely retryable, which must never run twice.
    action_class     text NOT NULL
                       CHECK (action_class IN ('send', 'publish', 'deploy', 'purchase',
                                               'delete', 'external_write', 'dns', 'billing')),
    target           text NOT NULL,
    summary          text,
    params           jsonb NOT NULL DEFAULT '{}'::jsonb,

    status           text NOT NULL DEFAULT 'claimed'
                       CHECK (status IN ('claimed', 'in_flight', 'succeeded',
                                         'failed', 'abandoned', 'needs_confirmation')),

    -- Proof the effect actually happened, from the far side where available:
    -- a message id, a PR number, a deployment id.
    receipt          jsonb,
    external_id      text,
    error            text,

    attempts         int NOT NULL DEFAULT 0,
    max_attempts     int NOT NULL DEFAULT 3,

    -- Ownership lease. A crashed holder's claim expires and becomes reclaimable
    -- rather than wedging the action forever.
    leased_by        text,
    lease_expires_at timestamptz,

    created_at       timestamptz NOT NULL DEFAULT now(),
    started_at       timestamptz,
    completed_at     timestamptz
);

CREATE INDEX actions_status_idx ON actions (status, created_at DESC);
CREATE INDEX actions_agent_idx  ON actions (agent_id, created_at DESC);
CREATE INDEX actions_class_idx  ON actions (action_class, created_at DESC);
CREATE INDEX actions_stale_lease_idx ON actions (lease_expires_at)
    WHERE status IN ('claimed', 'in_flight');

/**
 * Claim an action, or report that it is already accounted for.
 *
 * Returns the row plus `is_new`. A caller that sees is_new = false must NOT
 * perform the effect: either it already succeeded, or another holder has a live
 * lease on it. This is the whole point — the check and the claim are one atomic
 * step, so two agents racing the same action cannot both win.
 */
CREATE OR REPLACE FUNCTION claim_action(
    p_key           text,
    p_class         text,
    p_target        text,
    p_summary       text,
    p_params        jsonb,
    p_agent_id      uuid,
    p_session_id    uuid,
    p_lease_seconds int DEFAULT 300
)
RETURNS TABLE (action_id uuid, is_new boolean, current_status text)
LANGUAGE plpgsql AS $$
DECLARE
    v_id     uuid;
    v_status text;
BEGIN
    INSERT INTO actions (idempotency_key, action_class, target, summary, params,
                         agent_id, session_id, status, attempts,
                         leased_by, lease_expires_at, started_at)
    VALUES (p_key, p_class, p_target, p_summary, coalesce(p_params, '{}'::jsonb),
            p_agent_id, p_session_id, 'in_flight', 1,
            coalesce(p_session_id::text, 'unknown'),
            now() + make_interval(secs => p_lease_seconds), now())
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING actions.id INTO v_id;

    IF v_id IS NOT NULL THEN
        RETURN QUERY SELECT v_id, true, 'in_flight'::text;
        RETURN;
    END IF;

    SELECT a.id, a.status INTO v_id, v_status FROM actions a WHERE a.idempotency_key = p_key;

    -- A lease that has expired means the previous holder died mid-flight. The
    -- action becomes reclaimable, but attempts still increments so a effect
    -- that crashes the process every time cannot loop forever.
    IF v_status IN ('claimed', 'in_flight')
       AND EXISTS (SELECT 1 FROM actions a
                    WHERE a.id = v_id
                      AND a.lease_expires_at < now()
                      AND a.attempts < a.max_attempts)
    THEN
        UPDATE actions
           SET attempts = attempts + 1,
               leased_by = coalesce(p_session_id::text, 'unknown'),
               lease_expires_at = now() + make_interval(secs => p_lease_seconds),
               status = 'in_flight'
         WHERE id = v_id;
        RETURN QUERY SELECT v_id, true, 'in_flight'::text;
        RETURN;
    END IF;

    RETURN QUERY SELECT v_id, false, v_status;
END;
$$;

CREATE OR REPLACE FUNCTION complete_action(
    p_id          uuid,
    p_status      text,
    p_receipt     jsonb DEFAULT NULL,
    p_external_id text DEFAULT NULL,
    p_error       text DEFAULT NULL
)
RETURNS void LANGUAGE sql AS $$
    UPDATE actions
       SET status = p_status,
           receipt = coalesce(p_receipt, receipt),
           external_id = coalesce(p_external_id, external_id),
           error = p_error,
           completed_at = now(),
           lease_expires_at = NULL,
           leased_by = NULL
     WHERE id = p_id;
$$;

-- Actions whose holder died mid-flight and which are out of attempts. The
-- supervisor surfaces these rather than retrying: an external effect of unknown
-- outcome is a human decision, not something to guess at.
CREATE OR REPLACE VIEW actions_needing_attention AS
SELECT a.id, a.idempotency_key, a.action_class, a.target, a.summary,
       a.status, a.attempts, a.error, a.created_at,
       ag.slug AS agent
  FROM actions a
  LEFT JOIN agents ag ON ag.id = a.agent_id
 WHERE (a.status IN ('claimed', 'in_flight') AND a.lease_expires_at < now())
    OR a.status = 'needs_confirmation'
    OR (a.status = 'failed' AND a.attempts >= a.max_attempts);
