# External audit of Simba — GPT-5.6 Sol (Codex), 2026-08-04

Commissioned deliberately from a different model family than the one that wrote
the code, on the theory that a reviewer sharing the author's blind spots is not
a reviewer. Read-only: it changed nothing, and it validated its own findings
against the live database rather than stopping at the source.

15 findings. Verbatim below.

**Fixed so far:** #1 (surface authorisation on session send/kill) and the state
damage it evidenced under #11 (15 orphaned `running` turns under terminal
sessions). The rest stand as an ordered backlog.

Cost: 0.0000 USD — it ran on the Codex subscription, 6.7M input tokens.

---

I’ll conduct this as a read-only, source-traced audit. I’ll map the auth/policy boundary first, then session and mission lifecycles, and I’ll only report issues I can tie to a concrete trigger and exact code path.
The policy layer has been substantially hardened already: the tunnel listener verifies Cloudflare Access JWT signatures and pins issuer/audience, while the local listener rejects Cloudflare-marked traffic. I’m now tracing whether every HTTP and WebSocket path actually reaches that shared decision and whether downstream capabilities honor the selected surface.
I’ve found a recurring boundary failure: authentication selects a surface correctly, but several command routes do not enforce that surface’s capabilities. I’m also tracing two concrete continuity hazards now—parallel starts can bypass both the concurrency limit and worktree isolation, and reviving a completed session appears to create a new session ID that the API never returns.
I’m using Simba’s `postgres-psql-on-this-box` procedure for a read-only validation pass against the live schema. This won’t change state; it will tell me whether the source-traced failure states—stuck `verifying` missions, stale agent status, orphaned lineage, or budget undercount—are already present in Postgres.
The live database confirms the lifecycle defects are not hypothetical: one agent is marked `running` with zero live session rows, and 15 turns remain `running` under sessions already marked `completed`, `failed`, or `killed`. The repository still typechecks cleanly, so these are state-machine and authorization failures that static typing does not catch.
Read-only audit complete. I found four critical security/correctness faults and several high-severity lifecycle bugs. No files were changed; `npm run typecheck` passes, but I found no automated test suite.

## Critical

1. Lower-trust callers can commandeer desktop-authority sessions.

Authentication selects a surface, but `/sessions/:id/send` performs no authorization against that session or agent ([server.ts:568](/C:/workspace/simba/src/gateway/server.ts:568)). `SessionManager.send()` injects into the existing process—or revives it using its original surface ([manager.ts:422](/C:/workspace/simba/src/session/manager.ts:422), [manager.ts:501](/C:/workspace/simba/src/session/manager.ts:501)). The MCP action check later reads that stored origin ([server.ts:725](/C:/workspace/simba/src/mcp/server.ts:725)).

Trigger: a service token mapped to `automation` lists sessions, selects a desktop-origin session, then posts instructions to it. Those instructions execute with desktop authority. The same missing authorization affects kill, failover, brain toggles, mission controls, and roster creation; `can_modify_roster` and `can_spawn_agents` are defined but not enforced by those routes ([surface.ts:21](/C:/workspace/simba/src/policy/surface.ts:21), [server.ts:505](/C:/workspace/simba/src/gateway/server.ts:505)).

2. Surface restrictions are voluntary, not enforcement.

`checkAction()` is called only when the model voluntarily invokes `action_claim` ([server.ts:722](/C:/workspace/simba/src/mcp/server.ts:722)). Ordinary shell, edit, deployment, messaging, or deletion tool calls are merely recorded by the engine; no surface check occurs ([engine.ts:148](/C:/workspace/simba/src/session/engine.ts:148)).

Trigger: a phone-originated agent directly executes a delete or deployment without calling `action_claim`. The phone’s confirmation requirements are bypassed entirely.

3. The hard OS deny-list disappears on Codex, Cursor, and OpenCode.

The manager supplies both the generated hook settings and regexes ([manager.ts:207](/C:/workspace/simba/src/session/manager.ts:207)). Claude consumes the hook and Ollama checks the regexes internally, but:

- Codex starts with `--dangerously-bypass-approvals-and-sandbox` and never consumes either guard ([codex.ts:84](/C:/workspace/simba/src/runner/codex.ts:84)).
- Cursor uses `--force` without a guard ([cursor.ts:82](/C:/workspace/simba/src/runner/cursor.ts:82)).
- OpenCode uses `--auto`; its comment claims the profile enforces the deny-list, but no such code exists ([opencode.ts:177](/C:/workspace/simba/src/runner/opencode.ts:177)).

Trigger: failover from Claude to any of these runners, followed by a command matching the supposedly hard-blocked disk, boot, registry, or OS patterns. It runs unrestricted.

4. Expired action leases can duplicate irreversible effects.

`claim_action` automatically grants `proceed:true` again when an `in_flight` lease expires ([012_action_ledger.sql:108](/C:/workspace/simba/migrations/012_action_ledger.sql:108), [server.ts:781](/C:/workspace/simba/src/mcp/server.ts:781)).

Trigger: an email, purchase, deployment, or deletion succeeds, but the session crashes before `action_complete`; or the operation simply takes longer than 300 seconds. A retry reacquires the lease and repeats the effect. There is no lease renewal or proof that the first effect did not occur.

## High

5. Failover and revival detach the client from the real session.

Revival creates a new session ID, but `send()` discards it ([manager.ts:430](/C:/workspace/simba/src/session/manager.ts:430)) and the HTTP endpoint returns only `{ok:true}`. Failover similarly creates a new session and emits it inside `to`, without making it the active client ID ([manager.ts:383](/C:/workspace/simba/src/session/manager.ts:383)).

Both clients keep filtering events and sending against the old ID ([index.html:168](/C:/workspace/simba/app/index.html:168), [Chat.kt:104](/C:/workspace/simba/android/app/src/main/java/com/operator/simba/Chat.kt:104)).

Trigger: send a follow-up after reaping, restart, clean one-shot completion, or brain failover. Output from the continuation is invisible. A second follow-up to the old ID creates another child from the old parent, silently forking and losing the first follow-up’s context.

6. Mission failover double-spawns the same step.

Failover supersedes session A and starts continuation B, but `mission_steps.session_id` remains A. The executor sees A as terminal and requeues the step ([executor.ts:84](/C:/workspace/simba/src/missions/executor.ts:84)). Its attempted live-session guard compares a live session ID to the mission-step UUID, not the recorded session UUID ([executor.ts:93](/C:/workspace/simba/src/missions/executor.ts:93)).

Trigger: a mission step hits a limit, auth failure, or manual cross-tool failover. B continues while the next tick starts C for the same step.

7. Session ceilings and worktree isolation use non-atomic check-then-act logic.

`canReachAgent` counts only `running` and `idle`, excluding `pending` ([surface.ts:91](/C:/workspace/simba/src/policy/surface.ts:91)). Worktree isolation checks only the in-memory map before the new entry is registered ([manager.ts:191](/C:/workspace/simba/src/session/manager.ts:191), [manager.ts:248](/C:/workspace/simba/src/session/manager.ts:248)).

Trigger: two simultaneous start requests both see spare capacity and no live peer, then both run in the shared checkout.

A related deterministic bug lets `runSteps()` select two independent steps from one mission in one query, even when `max_concurrent_sessions=1`, because all selected rows see the pre-update snapshot ([executor.ts:225](/C:/workspace/simba/src/missions/executor.ts:225)).

8. One failed mission step normally wedges the mission in `verifying`.

`mission_step_complete` immediately stores failures as `failed` ([server.ts:634](/C:/workspace/simba/src/mcp/server.ts:634)). The executor moves any mission with no pending/running steps to `verifying`, even when failed steps exist ([executor.ts:304](/C:/workspace/simba/src/missions/executor.ts:304)). Completion requires every step to be succeeded/skipped, while budget and circuit-breaker enforcement only examines `running` missions.

Trigger: a step fails once, below the four-failure breaker. The mission remains `verifying` forever and is neither retried, failed, nor blocked.

9. Pause and cancel do not stop mission work already running.

The endpoint only updates the mission row ([server.ts:771](/C:/workspace/simba/src/gateway/server.ts:771)). No associated sessions are killed, and the executor reaps only steps already marked succeeded, failed, or skipped ([executor.ts:64](/C:/workspace/simba/src/missions/executor.ts:64)).

Trigger: press Cancel while a step is modifying files or performing an external operation. The API reports `cancelled`, but the agent continues.

10. Mission cost ceilings omit planning and previous attempts.

Cost roll-up sums only the session currently referenced by each step ([index.ts:47](/C:/workspace/simba/src/supervisor/index.ts:47)). Planning cost is never joined, and `planning_session_id` is cleared when the plan lands ([server.ts:619](/C:/workspace/simba/src/mcp/server.ts:619)). Requeueing clears the previous attempt’s session ID, and the next attempt overwrites it ([executor.ts:97](/C:/workspace/simba/src/missions/executor.ts:97), [executor.ts:267](/C:/workspace/simba/src/missions/executor.ts:267)).

Trigger: expensive planning or repeated failed attempts. Actual spend can exceed `max_cost_usd` while recorded mission cost stays below it.

11. Persistence and terminal lifecycle failures silently corrupt Postgres state.

Every event persistence error is logged and discarded without retry, dead-lettering, or stopping the session ([engine.ts:94](/C:/workspace/simba/src/session/engine.ts:94)). A transient database error therefore loses transcript/tool/usage data even though the live client sees the event.

The exit path also never finalizes an active turn and decides session success solely from process exit code ([engine.ts:351](/C:/workspace/simba/src/session/engine.ts:351)). Thus a failed `turn_end` followed by exit code 0 becomes a completed session. The manager’s exit listener deletes the live entry but never returns the agent to idle ([manager.ts:250](/C:/workspace/simba/src/session/manager.ts:250)).

Live Postgres already shows the damage:

- `scratch-worker` is marked `running` with zero live session rows.
- 15 turns remain `running` under terminal sessions: 12 killed, two failed, one completed.

12. Revival abandons an isolated worktree.

The revival query fetches `cwd` but not `worktree_path`, then launches the continuation from `cwd` ([manager.ts:452](/C:/workspace/simba/src/session/manager.ts:452), [manager.ts:501](/C:/workspace/simba/src/session/manager.ts:501)). Automatic reset recovery has the same defect ([index.ts:134](/C:/workspace/simba/src/supervisor/index.ts:134)).

Trigger: an isolated session leaves uncommitted work, is reaped/restarted/parked, then resumes. Its continuation runs in the shared checkout without those changes, while the only work remains stranded in the old worktree.

13. Approved confirmation requests can never execute.

Desktop approval changes an action to `claimed` and clears its lease ([server.ts:840](/C:/workspace/simba/src/gateway/server.ts:840)). `claim_action` only reacquires `claimed` actions when `lease_expires_at < now()`; `NULL < now()` is never true ([012_action_ledger.sql:111](/C:/workspace/simba/migrations/012_action_ledger.sql:111)).

Trigger: phone requests a deployment requiring confirmation; desktop approves it; the agent retries the claim and receives `proceed:false` forever.

14. An unknown mission owner silently escalates to Simba.

Mission creation uses a nullable subquery for the requested agent, so a typo inserts `owner_agent_id=NULL` ([server.ts:711](/C:/workspace/simba/src/gateway/server.ts:711)). Planning and execution then default null ownership to the tier-0 `simba` agent ([executor.ts:171](/C:/workspace/simba/src/missions/executor.ts:171), [executor.ts:255](/C:/workspace/simba/src/missions/executor.ts:255)).

Trigger: submit `agent: "windows-admn"`. Instead of rejecting the request, the mission silently runs as Simba.

## Medium

15. One environment variable can expose the trusted listener unauthenticated.

`SIMBA_GATEWAY_HOST` accepts arbitrary addresses ([config.ts:31](/C:/workspace/simba/src/config.ts:31)). Local authentication grants desktop authority without identity ([identity.ts:104](/C:/workspace/simba/src/policy/identity.ts:104)); literal-IP hosts and absent Origins are accepted.

Trigger: start with `SIMBA_GATEWAY_HOST=0.0.0.0`, then connect from the LAN to port 8787 with no Origin. The request receives desktop authority. The current listener is bound to `127.0.0.1`, so this is a latent configuration hazard, not a currently exposed port.

## Areas that held up

I did not find a serious cryptographic flaw in the Cloudflare Access verifier: it pins RS256, issuer, audience, required temporal claims, human allow-lists, and service-token identities ([access.ts:57](/C:/workspace/simba/src/policy/access.ts:57)). The main security failure occurs after authentication, where the selected surface is not consistently enforced.

The Android release configuration disables cleartext and stores Access credentials in encrypted preferences; I found no comparable serious defect there. Dirty-worktree deletion logic is also conservative—the loss risk is in resuming from the wrong directory, not cleanup.


