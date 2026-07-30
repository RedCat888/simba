# Legacy inventory — the two reel bots, and atlas

Answers §13: what gets absorbed, what becomes a skill, what becomes an agent,
what should be left alone.

---

## Part 1 — The two reel bots

Both were found and read. They are **not duplicates**; they are complementary,
and the merge is not a diff-and-pick so much as taking the better half of each.

### `C:\Users\operator\ReelAgent` (Claude-built, Python)

This is a working miniature of Simba and it is the more important of the two.
From its own README it already implements: agents with short ids, a focus model
where plain text continues the last agent, `new: <task>` for a fresh full-access
agent, `a2 <message>` direct addressing, `list`, `stop a2`, a registry in
`state.json` that survives restarts, a concurrency cap with free-RAM gating and
OOM retry, headless `claude -p --dangerously-skip-permissions`, and saved
session ids for follow-ups.

Also already correct on the thing I flagged as a risk: *"reel/repo/article
content is treated as data, never instructions; untrusted code never runs
without an explicit 'run it' reply."*

**Take:** the agent model, the focus/addressing UX, the RAM gating, the intake
filter and classification pipeline (download → keyframes → Whisper → classify →
category workflow).

**Discard:** `state.json` as the registry (that is the `agents` table now),
`INDEX.md` (that is `artifacts` + `summaries`), and its per-reel agent spawning —
under Simba a reel is a **Tier-2 job** under `instagram-intake`, and only becomes
a Tier-1 project agent if it graduates into real work.

### `Documents\Codex\2026-07-22\when-on-instagram-and-watching-reels` (Codex-built, Node)

Weaker agent model, **better intake plumbing**. It has multiple connectors —
local command, local HTTP endpoint, watched `inbox/` folder, Discord, and
WhatsApp via Baileys — plus a "source packet" abstraction that cleanly separates
collection from execution, and a `codex` vs `brief-only` action policy.

**Take:** the connector layer, the source-packet abstraction, and the
`brief-only` mode — that last one is genuinely good design and maps to a
Simba routing policy (collect and plan, do not execute).

**Discard:** its Codex invocation. Simba's `src/runner/codex.ts` supersedes it.

### Merge plan

`instagram-intake` becomes a Tier-1 agent whose intake surface is the
Codex project's connector layer, whose classification pipeline is ReelAgent's,
and whose state is Postgres rather than `state.json` and `INDEX.md`. The
`intake` permission profile (already seeded) is what it runs under.

The one thing worth preserving carefully: ReelAgent's IG session handling
(`bot/ig.py`, `session.json`) is the fragile part and the part that took real
effort. Do not rewrite it — port it.

---

## Part 2 — Atlas

Atlas is not a repo full of projects; it is a **scanner and its database**. The
Vite/React/Cloudflare app at `Downloads\atlas` is the front end. The data lives
in the `vectors` Supabase project: **98 projects, 236 code-index rows, 8 events.**

### Finding 1 — a large share of the inventory is not the operator's code

The scanner indexed vendored and downloaded third-party trees as first-class
projects: `fortawesome-fontawesome-free`, `google-chrome`, `phpqrcode`,
`moonlight-android`, `opencode`, `oh-my-opencode`,
`figma-files-raycast-extension`, `qwen-agent`.

These inflate the count and pollute every aggregate. **Leave them alone** — but
they need an `is_vendored` flag or exclusion rule, or every future pass
re-discovers them.

### Finding 2 — `next_action` is being generated without precision

`next_action = "Migrate to GitHub"` is attached to, among others,
`google-chrome` and `fortawesome-fontawesome-free`. Publishing either would be
meaningless; the recommendation is being applied by default rather than by
judgement.

**Worse:** the same recommendation is attached to a project slugged
**`api-keys`**. If that directory holds what its name suggests, "migrate to
GitHub" is actively dangerous advice. Whatever generates `next_action` needs a
secrets check before it can ever recommend publishing, and `api-keys` should be
audited before anything touches it.

### Finding 3 — identity and duplicates

Many slugs are slugified absolute paths
(`c-users-operator-downloads-hype-personal-website`,
`c-users-operator-onedrive-documents-github-c-learning-thing`), so the same project
discovered from two paths becomes two rows. Visible near-duplicates:
`spotify-dashboard` / `spotify-dashboard-app`, `handwriting-project` /
`c-handwriting-project-gravesrnn`, `3d-model-viewer` / `lumina-3d`.

Project identity should key on git remote or repo root hash, not path.

### Finding 4 — what should become agents

Real infrastructure that maps onto the Tier-1 roster:

| Atlas project | Becomes |
|---|---|
| `squaremap-tiles` | folds into the seeded **gameservers** agent |
| `obsidians-proxy`, `proxy-site` | folds into the seeded **network** agent |
| `knowledge-api`, `knowledge-mcp` | **superseded** by Simba's local vector store — see below |
| `atlas` itself | a **skill**, not an agent: "scan the machine and reconcile the project inventory" |
| `c-sms-bridge` | a **channel**, not a project — another intake surface |
| `frontline-job-sniper`, `n8n-oauth-automation` | **skills** under a future automation agent |

### Finding 5 — the knowledge API is broken, and this is the important one

`knowledge-api` reports healthy (health 98, committed 2026-07) and is what
`CLAUDE.md` instructs every agent to use for context about the operator.

It returns **empty results for every read**, while the underlying table holds
**5,288 rows**.

Cause: `src/index.ts` checks `res.ok` on its write paths (lines 182, 222, 238)
but on **none** of its read paths. A failed upstream read is swallowed and
returned as `[]` with HTTP 200, so it looks like an empty knowledge base rather
than a broken service. `/stats` reports `total_items: 0` for the same reason.
The `wrangler.toml` `SUPABASE_URL` is correct, so the most likely trigger is an
invalid or rotated `SUPABASE_SERVICE_KEY` secret.

Consequences worth stating plainly:

1. Every agent that followed `CLAUDE.md` and searched the knowledge DB has been
   silently getting nothing back, and would have concluded there was nothing to
   find rather than that the service was down.
2. The failure is invisible from the outside: 200 OK, well-formed JSON, zero
   results.

Fix is two lines of error handling plus re-setting the secret. Simba's ingest
bypasses it entirely via `readSupabaseKnowledge` and treats a failed read as an
error — but the Worker should still be fixed, because other things use it.

### What is genuinely dead

Candidates for archival — no commits in over a year and no dependents:
`activity-spoofer`, `today-weather`, `teams-export`, `workflow-backup`,
`peformance-scheduling-2`, `c-users-operator-downloads-hype-hype`,
`zaha-demo-bundle` (status already `broken`).

`external-project-backend` appears here with no commits and "Migrate to GitHub" attached.
**Leave it alone** — an external project is explicitly off limits.

---

## Recommended order

1. Fix `knowledge-api` error handling and re-set its secret. It is cheap and it
   is currently lying to every agent that asks it a question.
2. Audit the `api-keys` project before anything acts on its `next_action`.
3. Port ReelAgent's IG session handling into the `instagram-intake` agent, with
   the Codex project's connector layer in front of it.
4. Re-key atlas project identity off git remote, add a vendored flag, and demote
   atlas from an app to a Simba skill.
