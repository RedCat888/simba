# Simba

A personal operations system that happens to be able to code. One master agent,
reachable from a phone, running a Windows PC, a Mac, and a handful of cloud
accounts.

Not a coding-agent orchestrator. Coding is one domain among several.

---

## State as of 2026-07-30

Working and verified end to end on this machine:

- **Postgres 18.4 + pgvector 0.8.1** (built from source — no Windows binary
  exists) as the single source of truth. 41 tables, monthly partitioning on
  transcripts.
- **Real Claude Code sessions** driven over streaming stdin/stdout, with full
  transcripts, tool calls, per-turn cost and tokens landing in Postgres.
- **Multi-account isolation** via `CLAUDE_CONFIG_DIR`, verified to fully
  separate credentials and transcripts.
- **Checkpoint on every turn**, brain swap, park-until-reset, and automatic
  resume when a subscription's limit clears.
- **Session revival** — messaging a session whose process is gone transparently
  reattaches via native resume, so a gateway restart or a reboot is invisible.
- **Local vector store** — 63 Obsidian notes, 216 chunks, embedded locally via
  Ollama with no API key and no spend.
- **Control center UI** with live streaming, roster, brain usage, and a panic
  button.
- **Deny-list enforcement** as a `PreToolUse` hook, since sessions run with
  permissions bypassed.
- **Codex adapter**, verified with a real session. **Cross-tool failover works
  end to end** — Claude to Codex, with the receiving session inheriting the
  working tree and recovering its state through the MCP tools.
- **Inter-agent router**: TTL expiry, hop limits, loop detection, per-pair flood
  control, escalation to Simba. Verified against a seeded circular exchange.
- **Cursor adapter** written but unverified — see below.

## Brains: current state

| Brain | Status | Notes |
|---|---|---|
| claude-a | available | verified working |
| claude-b | logged_out | needs your login; see below |
| codex | usable | verified; models read from the account's own cache |
| cursor | logged_out | CLI reports no models available for the account |

Capabilities genuinely differ and the runner contract says so rather than
pretending otherwise. Claude supports real mid-turn steering via streaming
stdin. Codex and Cursor are one turn per process, so messages queue instead.

## Waiting on you

1. **Log in the second Claude account.** Everything is wired; the account is
   seeded as `logged_out` so the supervisor skips it. To activate:
   ```bash
   CLAUDE_CONFIG_DIR=C:\Users\operator\.simba-brains\claude-b claude
   ```
   Then `/login`. Cross-account failover cannot be fully exercised until this
   exists — a same-family swap is a transcript copy plus a resume, and there is
   currently nowhere to swap *to*.

2. **Chat exports.** Readers for both ChatGPT and Claude export formats are
   written and typechecked but unexercised — no export has been provided yet.
   ```bash
   npm run ingest -- chatgpt-export <path>
   ```

3. **A Supabase service key**, to ingest your knowledge corpus. It holds **5,288
   rows** — it is not empty. The Worker API in front of it returns empty results
   for every read because it checks response status on its write paths but not
   its read paths, so an auth failure surfaces as `[]` with HTTP 200. Every
   agent that followed `CLAUDE.md` and searched it has been silently getting
   nothing. `readSupabaseKnowledge` bypasses the Worker and treats a failed read
   as an error:
   ```bash
   SIMBA_SUPABASE_KEY=<service-key> npm run ingest -- knowledge-api
   ```
   The Worker still deserves the two-line fix, since other things use it.

4. **Sign in to `cursor-agent`** if you want Cursor in the chain. Its adapter is
   written, but the event mapping is unverified against a live stream and will
   likely need a correction on first real run.

5. **Audit the atlas project slugged `api-keys`.** Atlas has attached
   "Migrate to GitHub" to it. See `research/legacy-inventory.md`.

3. **Rotate the OpenClaw secrets.** `~/.openclaw/openclaw.json` currently holds
   a live Discord bot token and a Brave API key in plaintext, with
   `allowFrom: ["*"]` and unrestricted execution enabled. Details in
   `research/L0-gateway/openclaw-analysis.md`.

## Running it

```bash
npm install
powershell -File scripts/migrate.ps1
powershell -File scripts/restart-gateway.ps1
```

Then open <http://127.0.0.1:8787>.

```bash
npm run simba -- status              # system overview
npm run simba -- agents              # the roster
npm run simba -- brains              # subscription usage and limits
npm run simba -- search <query>      # semantic recall over your corpus
npm run simba -- transcript <id>     # full session transcript
npm run ingest -- obsidian           # re-ingest the vault (idempotent)
```

## Layout

```
migrations/     schema, applied in order, tracked in schema_migrations
src/db/         pool, typed accessors, append-only event log
src/runner/     tool-agnostic runner contract + Claude adapter
src/session/    session engine (persistence) and manager (failover)
src/hydration/  checkpoints, context assembly, git state, cheap completions
src/supervisor/ deterministic bookkeeping — no model in the loop
src/mcp/        the MCP server agents use to reach their own memory
src/ingest/     chat exports, Obsidian, knowledge API -> pgvector
src/gateway/    HTTP + websockets
app/            control center UI
research/       written analyses (clones are gitignored)
```

## Design notes worth knowing before changing anything

**An agent is an identity, not a process.** A row, a standing brief, an inbox,
a history. It spawns short, disposable sessions. Continuity comes from the
database and the hydration bundle, never from a long-lived context window. This
is why sleep/wake is trivial and why brain failover is possible at all.

**Failover is a ladder, not a switch.** Same CLI different account is a
transcript file copy plus `--resume`, which is near-lossless and is tried
first — it is also why both Claude accounts sit at the front of every brain
chain. Cross-tool is a fresh session seeded from a checkpoint, which is lossy
and is the fallback. Exhausting the chain parks the work until the earliest
reset rather than failing it.

**Cross-brain continuation and picking a thread up weeks later are the same
operation.** Failover is just cold resume with a hot worktree and a shorter
gap. Both go through `buildHydrationBrief`. Build them twice and they will
drift.

**Continuation is always explicit.** A brief only loads a checkpoint when the
caller asks to continue a specific session. Falling back to "this agent's most
recent checkpoint" looks helpful and makes a fresh task inherit unrelated
leftover state — the agent then argues with you about work that no longer
exists. This was a real bug, not a hypothetical.

**The checkpoint's `failures` field is the highest-value part of a handoff.**
Without it a rehydrated agent cheerfully re-walks every dead end its
predecessor already found.

**Cost is a delta.** The CLI reports `total_cost_usd` cumulatively for the
session. Charging the raw figure to each turn double-counts everything after
the first.

**`limit_resets_at` is not a gate on its own.** It is recorded on every
rate-limit event, including healthy ones, because a working account still
reports when its rolling window rolls over. It only gates when the account's
status is actually `limited`. Treating it as an unconditional gate benches
every working brain.

**The supervisor never calls a model.** Stalls, resumes, wakes, hop limits and
partition maintenance are timers and table lookups. Titling and summarization
go to a cheap model. High-tier brains are for reasoning, and a $20 plan spent
on secretarial work is the thing that makes limits bite.

**Never name an Ollama model that isn't pulled.** A missing model fails the
request, silently pushing every cheap call onto the subscription fallback —
which is exactly the spend the local path exists to avoid. `ollama list` is the
source of truth.
