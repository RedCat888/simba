# OpenClaw — analysis and extraction plan

Clone: `openclaw/openclaw` (installed here as npm `openclaw@2026.3.2`; local config
at `~/.openclaw` shows real use through ~March 2026).

## What it actually is

Not a coding-agent harness. It is a full personal-assistant platform, and its
`src/` has roughly seventy top-level subsystems. Abbreviated:

```
acp  agents  audit  auto-reply  boards  canvas  channels  chat  claws  cli
commands  commitments  context-engine  cron  daemon  fleet  flows  gateway
hooks  llm  media-*  memory  memory-host-sdk  model-catalog  model-picker
node-host  pairing  plugins  plugin-sdk  provider-runtime  proxy-capture
realtime-transcription  routing  secrets  security  sessions  skills  snapshot
state  system-agent  talk  tasks  tools  trajectory  transcripts  tts  tui
web-fetch  web-search  wizard  worker
```

This explains the original experience of not being able to make it do what was
wanted without constant issues. The problem was never that it is bad — it is
that it has strong opinions about **sessions, routing, memory and models**,
which are exactly the four things Simba needs to own. Two systems both
convinced they are the brain will fight forever.

## The verdict

**Take the transport and the node mesh. Reject the brain.**

OpenClaw is genuinely excellent at the boring, annoying infrastructure nobody
wants to write. It is a poor fit as an owner of agent state.

### Take

| Subsystem | Why |
|---|---|
| `pairing/` | Challenge-based device pairing with a real store (`pairing-challenge.ts`, `pairing-store-sqlite.ts`, `pairing-store-keys.ts`) and its own tests. This is the MacBook-as-node problem, already solved. Writing it from scratch is a week that buys nothing. |
| `node-host/` | Remote node execution — and it already contains `invoke-agent-cli-claude.ts`, i.e. invoking Claude Code on a paired remote node, plus `exec-policy.ts` for constraining what a node may run. Directly the "MacBook reachable for Mac-only work" requirement. |
| `channels/` | Multi-channel plumbing with `allow-from`/`allowlist-match` gating and per-account context. Useful as a reference even if the Discord/WhatsApp connectors from Reel-to-Action are used instead. |
| `cron/`, `daemon/` | Keeping a long-lived process alive on Windows and scheduling recurring work. |
| `secrets/` | Credential handling that stays out of the database — matches the requirement that secrets never land in Postgres or the Supabase mirror. |

### Reject

| Subsystem | Why |
|---|---|
| `sessions/`, `transcripts/`, `trajectory/` | Simba's whole thesis is that sessions and transcripts live in Postgres. Two session stores is the bug. |
| `memory/`, `context-engine/` | Directly conflicts with the hydration pipeline. Our bundle is DB-derived and checkpoint-driven. |
| `routing/`, `model-picker/`, `model-catalog/`, `llm/`, `provider-runtime/` | Brain selection is the actual IP here and is subscription-account-aware in a way OpenClaw's model abstraction is not. Its config assumes API keys (`OPENAI_API_KEY`, `GEMINI_API_KEY` in `openclaw.json`), which is the opposite of the constraint. |
| `agents/`, `fleet/`, `boards/`, `tasks/` | The roster is a database table. |

## The integration seam

OpenClaw becomes a **dumb pipe with a node mesh**: it receives messages and
forwards them to Simba's HTTP gateway; it exposes paired nodes as an execution
target Simba can call. It never decides anything.

The test of whether the boundary is drawn correctly: ripping OpenClaw out and
replacing it with the Discord connector that already exists in Reel-to-Action
should be a day's work. If it ever becomes a rewrite, it has crept back into
the core and should be pushed out again.

## Security finding in the live config — act on this

`~/.openclaw/openclaw.json` as it stands today contains, in plaintext:

- a **live Discord bot token**
- a **Brave Search API key**
- `channels.discord.allowFrom: ["*"]` with DMs enabled

combined with `agents.defaults.elevatedDefault: "full"`, `sandbox.mode: "off"`,
and `tools.elevated.enabled: true`.

Read together that is: anyone who can find and DM that bot gets an agent with
unrestricted execution on this PC. The gateway binds to loopback with a static
token (`"rad-openclaw-2026"`), but Discord is a cloud transport — loopback
binding does not gate it.

Recommended before OpenClaw is run again:
1. Rotate the Discord token and the Brave key.
2. Replace `allowFrom: ["*"]` with the specific Discord user id.
3. Move both secrets out of the JSON into the local secret store.

This is unrelated to Simba's design; it is just live on the machine right now.

## Note on ACP

OpenClaw ships an `acp/` subsystem, so Agent Client Protocol support is real
here rather than theoretical. Worth reading before writing the Codex and Cursor
adapters, on the chance ACP gives one protocol for several tools. Expectation
remains that ACP's event schema is worth stealing while ACP itself is not worth
adopting, because it assumes an editor client that supplies file operations —
a client Simba does not have.
