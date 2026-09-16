# simba

Personal operations system. One master agent, reachable from a phone, driving a
Windows PC, a Mac, and a handful of cloud accounts. Coding is one domain among
several — this is not a coding-agent orchestrator.

Read `README.md` for the current verified-state table before assuming a subsystem
works; it tracks which "brains" (claude-a/claude-b/codex/cursor) are live.

## Stack
- Node >=20, TypeScript, ESM (`"type": "module"`), run through `tsx`.
- hono + @hono/node-server (gateway), `ws`, `zod`, `jose` (Access JWT verification).
- **Postgres 18.4 + pgvector 0.8.1** — single source of truth, 41 tables, monthly
  partitioning on transcripts. Built from source; no Windows binary exists.
- `@modelcontextprotocol/sdk` — Simba exposes its own MCP server.
- Android client in `android/` (Gradle, Kotlin, `app.simba`).
  Electron-style desktop client in `desktop/`.

## Commands
```
npm run typecheck        # tsc --noEmit
npm test                 # tsx --test tests/*.test.ts
npm run check            # typecheck + test   <-- DEFINITION OF DONE
npm run migrate          # powershell -ExecutionPolicy Bypass -File scripts/migrate.ps1
npm run gateway          # tsx src/gateway/server.ts
npm run supervisor       # tsx src/supervisor/index.ts
npm run mcp              # tsx src/mcp/server.ts
npm run build:mcp        # node scripts/build-mcp.mjs
npm run ingest           # tsx src/ingest/cli.ts
npm run simba            # tsx src/cli.ts
npm run desktop          # npm start --prefix desktop
```
Android APK: build via Gradle in `android/` (`./gradlew assembleRelease`);
`scripts/publish-apk.ps1` handles release publishing. (unverified — confirm before use)

Run `npm run migrate` before starting the gateway against a fresh database.

## Architecture
- **gateway** (`src/gateway/`) — HTTP/WS front door. Phone, desktop, and Android all
  talk to this. Auth via Cloudflare Access JWT (`jose`) plus service tokens.
- **supervisor** (`src/supervisor/`) — owns agent session lifecycle: spawn, checkpoint
  every turn, brain swap, park-until-reset, revive. A session whose process died
  reattaches transparently via native resume, so a gateway restart is invisible.
- **mcp** (`src/mcp/`) — the tool surface agents call back into.
- **router** (`src/router/`) — inter-agent messaging: TTL expiry, hop limits, loop
  detection, per-pair flood control, escalation to Simba.
- **policy** (`src/policy/`) — deny-list enforcement as a `PreToolUse` hook. Sessions
  run with permissions bypassed, so this is the only guardrail. Do not weaken it.
- **knowledge/** + **hydration/** — memory, embeddings (local Ollama, no API spend),
  curation, context budgeting, checkpoints.
- Also: `db/`, `session/`, `missions/`, `runner/`, `inventory/`, `tools/`, `voice/`, `ops/`.

## Layout
- `src/` — all services above. `src/cli.ts` is the operator CLI.
- `migrations/` — `001_extensions` … `010_claude_b_live`, applied by `scripts/migrate.ps1`.
- `tests/` — `persist.test.ts`, `regressions.test.ts` (node test runner via tsx).
- `scripts/` — ops PowerShell (tunnel, keepalive, autostart, restart-gateway,
  publish-apk) and a large family of `probe-*.ts` one-off verification harnesses.
  Look for an existing probe before writing a new diagnostic.
- `android/`, `desktop/`, `config/`, `research/`.
- `var/` — runtime state, very large. Do not enumerate or read deeply.

## Gotchas
- Two junk zero-byte files sit in the repo root, literally named `console.log('ok` and
  `console.log('refused`. They are artifacts of a past shell-escaping bug. Safe to
  delete, but they are harmless — do not "fix" them by editing.
- Sessions run with permissions bypassed. The deny-list `PreToolUse` hook in
  `src/policy/` is the containment boundary; treat changes there as security changes.
- `npm run migrate` shells out to PowerShell — it is Windows-only.
- The Cursor adapter is written but unverified. Do not assume it works.
- `android/local.properties` is machine-specific and must not be committed.

## Rules
- **Definition of done: `npm run check` exits 0.** Do not declare work complete before
  that. If it fails, fix and re-run — do not report success with a red suite.
- Any shell command over 3 lines: write a script file with the Write tool, then run it.
  No heredocs.
- PowerShell strings must be ASCII only — em dashes and smart quotes break the parser.
- **NEVER taskkill/kill `node.exe`, `java.exe`, or Gradle daemons** without listing the
  process and asking first. Killing Gradle daemons has broken in-flight Android builds
  on this machine before.
- This machine has a history of **commit-charge / pagefile exhaustion**. Before blaming
  a Gradle or build failure on the code, check commit charge and pagefile size first —
  that has been the real root cause more than once.
- On long autonomous runs, checkpoint progress and the next step to disk and commit at
  each milestone. Assume the session can be cut off at any moment.

## Env vars (names only — never commit values)
Gateway/auth: `SIMBA_GATEWAY_HOST`, `SIMBA_GATEWAY_PORT`, `SIMBA_GATEWAY_TOKEN`,
`SIMBA_ACCESS_AUD`, `SIMBA_ACCESS_TEAM`, `SIMBA_ACCESS_EMAILS`,
`SIMBA_ACCESS_SERVICE_TOKENS`, `SIMBA_TUNNEL_ENABLED`, `SIMBA_TUNNEL_PORT`.
Postgres: `SIMBA_PG_HOST`, `SIMBA_PG_PORT`, `SIMBA_PG_USER`, `SIMBA_PG_PASSWORD`,
`SIMBA_PG_DATABASE`.
Models/brains: `SIMBA_CLAUDE_BIN`, `SIMBA_CODEX_BIN`, `SIMBA_CURSOR_BIN`,
`SIMBA_OPENCODE_BIN`, `SIMBA_CHEAP_MODEL`, `SIMBA_EMBED_MODEL`, `SIMBA_OPENAI_MODEL`,
`SIMBA_OPENCODE_MODEL`, `SIMBA_OLLAMA_URL`, `SIMBA_WHISPER_MODEL`, `SIMBA_VOICE_WORKER`.
Integrations: `SIMBA_SUPABASE_URL`, `SIMBA_SUPABASE_KEY`, `SIMBA_REEL_URL`,
`SIMBA_REEL_TOKEN`, `SIMBA_KNOWLEDGE_TOKEN`, `DISCORD_TOKEN`, `DISCORD_BOT_TOKEN`,
`DISCORD_INTAKE_CHANNELS`, `GOOGLE_ACCESS_TOKEN`, `GMAIL_ACCESS_TOKEN`,
`MICROSOFT_ACCESS_TOKEN`, `MS_GRAPH_TOKEN`.
Runtime: `SIMBA_AGENT_ID`, `SIMBA_SESSION_ID`, `SIMBA_VAULT`, `SIMBA_DEBUG`,
`SIMBA_BRIEF_MINUTES`, `SIMBA_REAP_IDLE_MINUTES`.
