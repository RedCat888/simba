# OmniRoute — evaluated, not adopted

Repo: `C:\Users\operator\ReelAgent\repos\OmniRoute` (github: diegosouzapw/OmniRoute, MIT)

## What it claims

"The Free AI Gateway." 278 providers, 90+ free tiers, ~1.53B free tokens/month,
18 routing strategies, one OpenAI-compatible endpoint in front of all of it, plus
RTK + "Caveman" prompt compression claiming 15–95% token savings. Points Claude
Code, Codex, Cursor, Cline and Copilot at free Claude/GPT/Gemini with auto-fallback.

## What it actually is

A full Next.js application, not a library:

- Next.js app + React dashboard + Electron desktop build + Docker/fly.toml
- SQLite store, JWT dashboard sessions, encrypted-at-rest key vault
- Requires `JWT_SECRET`, `API_KEY_SECRET` and `INITIAL_PASSWORD` before first boot

## Why it was not adopted

**Every free tier is an API key you sign up for.** `.env.example` is a list of
per-provider credentials — `DEEPSEEK_API_KEY`, `NVIDIA_API_KEY`, `WINDSURF_API_KEY`,
`OPENCODE_API_KEY` and so on. The 1.53B free tokens are the *sum of what those
providers give you* once you have registered at each. OmniRoute does not supply
credentials; it aggregates and rotates the ones you bring. With no keys configured
it routes to nothing.

That collides with two of Simba's constraints at once:

1. **No API keys.** The rule was framed as "no metered spending", and free-tier
   keys are not spending — so this is not a hard veto. But it is ~40 manual
   signups, and account creation is not something Simba can do on the user's
   behalf.
2. **It is a second always-on server.** Next.js + SQLite + dashboard + auth,
   running permanently, to reach providers Simba currently cannot reach.

And the decisive detail: the one provider in its catalog reachable **without** a
key is OpenCode Zen — which Simba now calls directly (`src/hydration/opencode.ts`,
measured 5/5, ~30s/call). So standing the gateway up today would return exactly
what Simba already has, at the cost of another service to run and keep alive.

## What was taken instead

The interface, not the implementation. `src/hydration/openai-compat.ts` speaks the
OpenAI `/chat/completions` protocol directly, so any backend can sit behind it:

```
SIMBA_OPENAI_BASE=http://localhost:1234/v1     # LM Studio, llama.cpp, vLLM…
SIMBA_OPENAI_KEY=…                             # optional
SIMBA_OPENAI_MODEL=…
```

Unset, it is inert and costs nothing. Set, it takes priority in the cheap chain —
a deliberate user configuration outranks any default ordering. This means if the
user later *does* want OmniRoute, running it and setting one variable is the whole
integration: OmniRoute exposes precisely this protocol.

## Worth revisiting if

- The user obtains free-tier keys and wants them pooled and rotated with
  budget tracking — that is genuinely OmniRoute's strength and rebuilding it
  would be foolish.
- The prompt-compression claim (RTK + Caveman, ~89% avg) proves out. That is the
  most interesting idea in the repo and is independent of the gateway; worth
  reading `src/` for it even without adopting the service.

## Current free-model position

| Provider | Key needed | Status | Latency |
|---|---|---|---|
| OpenCode Zen (`opencode/big-pickle`) | no | working, 5/5 | ~30s |
| Ollama local (`qwen2.5-coder:14b`) | no | working | ~16 tok/s |
| OpenAI-compatible endpoint | depends | wired, unconfigured | — |
| Claude Haiku (subscription) | no | working, fallback | fast |

Models probed on OpenCode and rejected: `minimax-m2.5-free` and `gpt-5-nano`
return server errors; `github-copilot/*` authenticate but report "not licensed
to use Copilot".
