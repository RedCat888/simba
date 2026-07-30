# How the alternatives drive coding agents — and what Simba takes

Three approaches examined: `vibe-kanban` (Rust), `claude-squad` (Go),
`emdash` (TypeScript). The question each was read to answer: **how do you drive
Claude Code, Codex and Cursor as real, resumable sessions rather than one-shot
invocations?**

## Summary

| | claude-squad | emdash | vibe-kanban | Simba |
|---|---|---|---|---|
| Drive method | tmux + PTY | plugin runtime over a wire protocol | per-tool executor processes | headless stream-json, long-lived stdin |
| Agents supported | Claude (+ a few) | plugin-defined | 9 (claude, codex, cursor, gemini, opencode, amp, copilot, droid, qwen) | claude (codex/cursor pending) |
| Session state | tmux pane + local storage | workspace-server | SQLite | Postgres |
| Resume | re-attach to pane | runtime-managed | `coding_agent_follow_up` | native `--resume` + transcript copy |
| Remote access | — | desktop app | full `relay-*` stack (ws, webrtc, tunnel) | Cloudflare Tunnel |

## claude-squad — the approach to *not* copy

`session/` contains `tmux.go`, `tmux_unix.go`, `pty.go` alongside a substantial
worktree implementation (`worktree.go`, `worktree_branch.go`, `worktree_git.go`,
`worktree_ops.go`).

It drives the **interactive TUI through a pseudo-terminal** and reads the rendered
screen. That is the fallback you take when you do not have a structured output
mode. Spike zero established that Claude Code has `--output-format stream-json`
with a documented event stream, so screen-scraping buys nothing and costs
everything: ANSI parsing, terminal-width dependence, and breakage on every CLI
version bump.

Also relevant: `tmux_unix.go` signals a Unix assumption throughout, and this
system is Windows-first.

**Take:** nothing from the driving layer. The worktree code is worth reading if
Claude Code's native `-w/--worktree` proves insufficient for branch-per-session
hygiene, but that is a maybe, not a plan.

## emdash — good structure, wrong shape for this

`packages/` splits into `core`, `runtime`, `plugins`, `wire`, `shared`, `ui`,
`chat-ui`, with `apps/workspace-server` and `apps/emdash-desktop`. A clean
plugin runtime behind a wire protocol.

The architecture is sound but it is a desktop product with a plugin ecosystem,
and adopting the runtime would mean adopting its process and state model — the
same conflict as OpenClaw's session subsystem, at a smaller scale.

**Take:** the `wire` protocol shape as a reference for the normalized event
union, nothing structural.

## vibe-kanban — the most valuable clone by a distance

Two independently useful things.

### 1. `crates/executors/` — nine real agent adapters

```
claude.rs  codex.rs  cursor.rs  gemini.rs  opencode.rs
amp.rs     copilot.rs  droid.rs  qwen.rs
```

plus, in the same crate:

- `coding_agent_initial.rs` / `coding_agent_follow_up.rs` — exactly the
  start-vs-resume split Simba's runner makes
- `mcp_config.rs` — per-session MCP config generation, the same technique used
  for the Simba MCP server
- `model_selector.rs` — tier-to-model resolution
- `approvals.rs`, `env.rs`, `command.rs`, `stdout_dup.rs`
- `executor_discovery.rs` — locating CLI binaries, which is a real problem here
  (Codex is not on PATH; it lives inside the Reel-to-Action project's
  `node_modules/.bin`)

**This is the single highest-value artifact in the research set.** `codex.rs`
and `cursor.rs` are working solutions to the two adapters Simba still needs.
Reading them is worth more than writing those adapters from scratch, because
the cost there is discovery — flag names, output shapes, resume semantics — not
code.

**Action:** read `codex.rs` and `cursor.rs` closely before implementing
`src/runner/codex.ts` and `src/runner/cursor.ts`.

### 2. The `relay-*` crates — a real alternative for phone access

```
relay-client  relay-control  relay-hosts  relay-protocol  relay-tunnel
relay-tunnel-core  relay-types  relay-webrtc  relay-ws
```

A complete self-hosted remote-access stack including WebRTC and WebSocket
transports, plus `embedded-ssh` and `preview-proxy`.

The plan is Cloudflare Tunnel fronted by Cloudflare Access, which remains the
right call — it is less code, it is already paid for, and Access is a real
identity gate. But this is the credible fallback if the tunnel proves awkward,
and `preview-proxy` is directly relevant to reaching a dev server running inside
an agent's worktree from the phone.

**Take:** Cloudflare Tunnel stays. Note `relay-*` and `preview-proxy` as the
known alternative rather than re-deriving one later.

## What was confirmed about Simba's own choices

1. **Headless stream-json over PTY** — vindicated. claude-squad only screen-scrapes
   because it predates or ignores structured output; vibe-kanban runs executor
   processes and parses their output, which is the same conclusion.
2. **Per-session MCP config generation** — vibe-kanban does this too
   (`mcp_config.rs`). Independent arrival at the same technique is a good sign.
3. **Initial vs follow-up as distinct paths** — `coding_agent_initial` /
   `coding_agent_follow_up` mirrors Simba's launch-vs-resume split exactly.
4. **Executor discovery is a real problem** — vibe-kanban has a whole module for
   it, and this machine already demonstrates why: `claude` resolves from
   `~/.local/bin`, `cursor-agent` from `%LOCALAPPDATA%`, and `codex` is not on
   PATH at all. Simba currently hardcodes the Claude path in `src/runner/claude.ts`
   and needs a discovery module before the other two adapters land.

## Nothing here does what Simba does

Worth stating plainly, because it is the reason this is being built rather than
adopted: every one of these three is a **coding-agent orchestrator**. They exist
to run agents against repositories and produce pull requests.

None of them has: subscription-account failover, a portable session that
survives moving between accounts and tools, a durable agent identity separate
from any process, or an operations system that treats coding as one domain
alongside a Windows PC, a game server and an Instagram intake queue.

The executor adapters are worth taking. The premise is not shared.
