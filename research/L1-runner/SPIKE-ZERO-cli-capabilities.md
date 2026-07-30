# Spike Zero — CLI isolation, protocol, and capability findings

Run on PROJECT-ODIUM, 2026-07-30. Claude Code v2.1.118.

This spike existed to answer one question: **is subscription-only brain routing
actually buildable?** The answer is yes, and by a wider margin than the design
conversation assumed. Several things I planned to build by hand turn out to be
first-class CLI features.

---

## 1. Multi-account isolation — CONFIRMED

`CLAUDE_CONFIG_DIR` fully isolates an account.

Pointing it at an empty directory and running a print-mode turn produced:

```json
{"type":"result","is_error":true,"result":"Not logged in · Please run /login",
 "session_id":"4e5df90e-...","total_cost_usd":0}
```

and populated the new directory with its own `.claude.json`, `sessions/`,
`projects/`, `backups/`.

Three things matter here:

- Account A's credentials were **not** read. The isolation is real, not partial.
- Failure was **clean and non-interactive** — exit with a structured JSON error
  rather than hanging on a login prompt. A logged-out brain is therefore
  detectable programmatically, which is what lets the supervisor skip it.
- Transcripts live *inside* the config dir (`projects/`, `sessions/`), which is
  what makes same-tool failover cheap — see §4.

**Consequence:** `brain_accounts.config_dir` is the entire isolation mechanism.
Two Claude subscriptions on one Windows machine is two directories and one
environment variable. This is clean, not hacky.

---

## 2. We control session identity

`--session-id <uuid>` makes Claude Code adopt an identifier we generate. The
assigned UUID was echoed in `system/init`, every streamed event, and the final
result.

**Consequence:** `sessions.id` and `sessions.native_session_id` can be the same
value. No scraping a session id out of output, no reconciliation step, no race
between "we started a session" and "we learned what it's called". Simba assigns
identity; the tool adopts it.

`--fork-session` resumes into a *new* id, which is the natural primitive for
branching a session rather than continuing it.

---

## 3. Rate limits arrive as structured events — this replaces the whole
##    "usage detection" subsystem

A dedicated event type is emitted during normal operation, unprompted:

```json
{"type":"rate_limit_event",
 "rate_limit_info":{
   "status":"allowed",
   "resetsAt":1785457800,
   "rateLimitType":"five_hour",
   "overageStatus":"allowed",
   "overageResetsAt":1785542400,
   "isUsingOverage":false},
 "session_id":"..."}
```

This was the part of §8 I flagged as needing both self-tracking and error
parsing, with an admission that we'd get it wrong sometimes. That's no longer
true for Claude:

- `status` reports headroom **before** a turn dies, not after.
- `resetsAt` is a unix epoch — exactly the input `sleep_until_reset` needs. The
  "wait until limits reset and pick work back up" feature is now a scheduled
  timer against a number the CLI hands us, not a guess.
- `rateLimitType` distinguishes the five-hour window from the weekly one, so a
  five-hour exhaustion can swap brains while a weekly exhaustion can mark the
  account down for much longer.
- Overage fields tell us whether we're spending past the plan.

**Consequence:** the supervisor's limit detection is a pure function of this
event. Self-tracking in the `usage` table stays, but demoted from load-bearing
to cross-check and cost reporting. Text-scraping error strings is not needed at
all for Claude.

Caveat worth stating: I have only observed `status: "allowed"`. The exact
strings for degraded and exhausted states are unverified — the supervisor
therefore treats any status other than `allowed` as non-nominal and records the
literal value, rather than switching on an enum I guessed at.

---

## 4. Same-tool failover is a file copy

Transcripts persist as JSONL under `<CLAUDE_CONFIG_DIR>/projects/<slug>/`.
Credentials live in `.claude.json` / `.credentials.json` in the same tree but
are separate files.

**Consequence:** moving a live session from Claude account A to account B is:
copy the transcript file into B's config dir, then `--resume` under B's
`CLAUDE_CONFIG_DIR`. Near-lossless, no summarization, no context rebuild. This
is the primary failover path and it should be tried before any cross-tool
handoff. Cross-tool rehydration is the fallback, not the default.

---

## 5. Real bidirectional streaming and steering exist

- `--input-format stream-json` — realtime streaming **input**. This is genuine
  mid-turn steering, not queue-until-turn-end.
- `--output-format stream-json` — realtime streaming output.
- `--include-partial-messages` — token-level deltas for live display.
- `--replay-user-messages` — echoes injected user messages back on stdout so
  the sender can confirm an injection was accepted.

**Consequence:** the Claude runner advertises the full capability set
`{stream, steer, interrupt, resume}`. The plan to start with ephemeral
process-per-turn and add steering later is unnecessary for Claude — build the
long-lived streaming runner directly. Process fragility is acceptable because
the process is a cache, not the truth: if it dies we rehydrate.

---

## 6. Other flags that remove work from the build

| Flag | Replaces |
|---|---|
| `--append-system-prompt` | The injection point for the hydration brief. No file materialization needed for the brief itself. |
| `--mcp-config` + `--strict-mcp-config` | Inject only Simba's MCP server; suppress ambient ones. ReelAgent already uses `--strict-mcp-config` for speed. |
| `-w, --worktree` | Native git worktree creation per session. The emdash worktree-isolation pattern may be partly redundant. |
| `--max-budget-usd` | Per-session hard budget cap, enforced by the CLI. |
| `--effort low\|medium\|high\|xhigh\|max` | The "standard-high thinking" requirement for Simba. |
| `--model opus\|sonnet` | Tier resolution; aliases work, no pinned model strings needed. |
| `--fallback-model` | CLI-level fallback when a model is overloaded — distinct from our brain failover, and complementary. |
| `--permission-mode bypassPermissions` | Full-perms default without the scarier `--dangerously-skip-permissions` spelling. |

---

## 7. Event → schema mapping

Observed event stream for one tool-using turn:

```
system/init        → session metadata: cwd, model, permissionMode, apiKeySource, tools[]
rate_limit_event   → brain_accounts.status / limit_resets_at, usage cross-check
assistant          → messages(role=assistant); content blocks of type text | tool_use
user               → messages(role=user); content blocks of type tool_result
result/success     → turns: cost, tokens, stop_reason; session totals
```

Tool calls correlate cleanly: `tool_use.id` on the assistant side matches
`tool_result.tool_use_id` on the user side, giving a complete `tool_calls` row
with args, result and error flag.

The final `result` envelope carries `total_cost_usd`, `usage`
(`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`), `modelUsage`, `permission_denials`, `stop_reason`
and `terminal_reason` — a direct fill of the `turns` and `usage` tables.

One quirk to guard against: the logged-out response had
`subtype: "success"` alongside `is_error: true`. **Check `is_error`, never
`subtype`.**

`apiKeySource: "none"` confirms subscription auth is in use, which gives a
cheap way to verify a brain account is on a plan rather than a key.

---

## 8. Status of the other CLIs

- `cursor-agent` — present at `%LOCALAPPDATA%\cursor-agent`. Not yet probed.
- `codex` — **not on PATH**. Installed locally inside the Reel-to-Action project
  (`node_modules/.bin/codex`), consistent with that project's stated approach of
  avoiding the Windows Store executable. `~/.codex` exists with `auth.json`,
  `config.toml`, `sessions/`, and several SQLite stores — so an account is
  configured. Adapter work pending.

---

## Net effect on the build

Three subsystems got smaller or disappeared:

1. Usage prediction — replaced by a structured event.
2. Session-id reconciliation — replaced by `--session-id`.
3. Ephemeral-then-upgrade runner staging — skipped; build streaming directly.

One got more important: **the transcript-copy path for same-account-family
failover**, which is cheaper and higher fidelity than anything cross-tool and
should be the default the supervisor reaches for first.
