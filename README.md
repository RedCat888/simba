# Simba

Simba is a self-hosted operations system for coordinating coding agents and
local work from a browser or Android client. It stores durable state in
Postgres and treats each agent session as disposable: context, checkpoints,
costs, and handoffs live in the database rather than in one long-running
model conversation.

This repository intentionally contains no production accounts, machine paths,
session captures, chat exports, screenshots, or credentials. Use the example
configuration and create local runtime state outside Git.

## What it provides

- A gateway with HTTP and WebSocket APIs for agent/session orchestration.
- Adapters for supported coding CLIs, with explicit capability differences.
- Durable session events, checkpoints, worktree state, and usage accounting in
  Postgres.
- A browser control center and an Android client.
- An MCP server for structured session and memory operations.

## Repository layout

```
migrations/     database schema and seed-safe development data
src/db/         pool and typed data access
src/runner/     CLI runner adapters
src/session/    session lifecycle, checkpoints, and worktrees
src/supervisor/ deterministic scheduling and bookkeeping
src/gateway/    HTTP and WebSocket gateway
src/mcp/        MCP surface used by agents
src/ingest/     optional local-data ingestion adapters
app/            browser control center
android/        Android client
```

## Local development

Prerequisites: Node.js, PostgreSQL, and PowerShell on Windows for the supplied
maintenance scripts. The Android client additionally needs a current Android
SDK and JDK.

```bash
npm install
powershell -File scripts/migrate.ps1
powershell -File scripts/restart-gateway.ps1
```

The gateway listens on the address configured in your local environment. Do
not expose it to an untrusted network; configure authentication before enabling
any remote access.

Useful commands:

```bash
npm run simba -- status
npm run simba -- agents
npm run simba -- brains
npm run simba -- transcript <session-id>
```

## Privacy and security posture

- Keep `.env`, CLI credentials, exports, databases, screenshots, and captured
  API responses out of Git.
- Create synthetic fixtures for tests. Do not commit responses captured from a
  live gateway.
- Treat service tokens and remote gateway access as high-impact credentials;
  rotate them if they are ever copied into logs or source control.
- Run destructive or external side-effecting work through an explicit approval
  policy; a model instruction is not an authorization boundary.

## Contributing

Before sharing a branch, run the relevant test suite and scan changed files for
credentials, local paths, captured runtime data, and organization-specific
identifiers. Keep documentation reproducible from a clean checkout.
