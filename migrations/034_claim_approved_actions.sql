-- An approved confirmation could never actually execute.
--
-- Found by external audit. Rewritten from the live function definition rather
-- than from the original migration, because a first attempt guessed the
-- signature (p_kind/p_payload instead of p_class/p_target/p_params) and created
-- a second overload alongside the real one instead of replacing it. That is
-- worse than the bug it was fixing, so the wrong overload was dropped and this
-- is generated from pg_get_functiondef.

CREATE OR REPLACE FUNCTION public.claim_action(p_key text, p_class text, p_target text, p_summary text, p_params jsonb, p_agent_id uuid, p_session_id uuid, p_lease_seconds integer DEFAULT 300)
 RETURNS TABLE(action_id uuid, is_new boolean, current_status text)
 LANGUAGE plpgsql
AS $function$
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

    -- Reclaimable in two cases. An expired lease means the previous holder died
    -- mid-flight. A *cleared* lease on a 'claimed' action means a human
    -- approved it and handed it back deliberately.
    --
    -- The second case used to be unreachable: approval sets lease_expires_at to
    -- NULL, and `NULL < now()` is NULL rather than true, so an approved action
    -- could never be claimed and the agent got proceed:false forever. Approving
    -- something was indistinguishable from ignoring it - the worst outcome for a
    -- confirmation flow, because the user believes they authorised the work.
    --
    -- NULL leases on any other status stay non-claimable: nothing else creates
    -- them, and treating unknown states as available is how an irreversible
    -- effect gets repeated.
    IF v_status IN ('claimed', 'in_flight')
       AND EXISTS (SELECT 1 FROM actions a
                    WHERE a.id = v_id
                      AND (a.lease_expires_at < now()
                           OR (a.lease_expires_at IS NULL AND a.status = 'claimed'))
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
$function$;
