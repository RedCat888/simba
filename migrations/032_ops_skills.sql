-- Operational lessons from the first real mission run, written down once.
--
-- Worth recording because the planner demonstrably reads this index: the doctor
-- mission's own step 1 was "Load Postgres connection details from skill", chosen
-- without being told. Skills are not documentation here, they are inputs to
-- planning, so a lesson written well changes what future agents decide to do.

INSERT INTO skills (name, description, body, tags, source) VALUES
(
  'sizing-a-mission-budget',
  'Use when creating a mission. One step costs one session.',
  E'# Sizing a mission budget\n\n'
  '`max_sessions` is spent at roughly **one session per step**, not one per\n'
  'mission. A session is released when its step finishes, but the release does\n'
  'not refund the budget — it frees a concurrency slot, which is a different\n'
  'resource.\n\n'
  '## The failure this causes\n\n'
  'An eight-step mission given `maxSessions: 6` runs five steps, then stops with\n'
  '`mission blocked: session budget exhausted`. Nothing is broken and nothing is\n'
  'retried — the circuit breaker did its job. It just cannot finish.\n\n'
  '## Rule\n\n'
  'Plans tend to decompose further than expected. A task that sounds like three\n'
  'steps planned as eight. Budget **2-3x the step count you imagine**, or leave\n'
  'the default (40) alone unless there is a specific reason to cap it.\n\n'
  '## Unblocking one\n\n'
  'Raising the ceiling clears the block and resumes in one call:\n\n'
  '```bash\n'
  'curl -X POST http://127.0.0.1:8787/api/missions/<id>/budget \\\n'
  '  -H "content-type: application/json" -d ''{"maxSessions":20,"maxCostUsd":10}''\n'
  '```\n\n'
  'The app offers the same thing beside the blocked reason. Budgets only ever go\n'
  'up — a lower value is ignored rather than applied, because lowering mid-flight\n'
  'would re-block on the next tick.',
  ARRAY['missions','budgets','operations'],
  'authored'
),
(
  'restarting-the-simba-gateway',
  'Use when gateway code changed and the running process is stale.',
  E'# Restarting the gateway\n\n'
  'The gateway hosts the HTTP API, the WebSocket stream, **and the supervisor**\n'
  'that drives missions and failover. Editing `src/gateway/server.ts` changes\n'
  'nothing until it is restarted — new routes 404 against the old process.\n\n'
  '## Procedure\n\n'
  '```powershell\n'
  'Get-CimInstance Win32_Process -Filter "Name=''node.exe''" |\n'
  '  Where-Object { $_.CommandLine -match ''gateway/server'' } |\n'
  '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\n'
  'Start-Process powershell -ArgumentList "-NoProfile","-Command",\n'
  '  "cd C:\\Users\\operator\\simba; npm run gateway" -WindowStyle Hidden\n'
  '```\n\n'
  'Then wait for it rather than sleeping a guess:\n\n'
  '```bash\n'
  'until curl -s --max-time 3 http://127.0.0.1:8787/api/stats >/dev/null; do sleep 1; done\n'
  '```\n\n'
  '## Two processes is normal\n\n'
  'Matching `gateway/server` finds **two** node processes: the tsx wrapper and\n'
  'its child, which is the one holding port 8787. That is a parent/child pair,\n'
  'not a leaked duplicate. Confirm with `netstat -ano | findstr :8787` before\n'
  'concluding anything is wrong.\n\n'
  '## Never run two\n\n'
  'A second gateway means a second supervisor scheduling sessions alongside the\n'
  'first. It now refuses to start and exits with a message naming the cause, so\n'
  'a failed start is safe — but check for a live session before restarting, since\n'
  'killing the process kills CLI children with it:\n\n'
  '```bash\n'
  'curl -s http://127.0.0.1:8787/api/sessions | grep -c ''"status":"running"''\n'
  '```',
  ARRAY['operations','gateway','simba'],
  'authored'
),
(
  'running-work-for-free',
  'Use when work is bulk, background, or unattended — pick the free brain.',
  E'# Running work for free\n\n'
  'The whole system runs on two $20 plans, so the question for any unattended\n'
  'work is not "which model is best" but "does this need to cost anything".\n\n'
  '## The chains\n\n'
  '| Tier | Chain |\n'
  '|---|---|\n'
  '| 0 — Simba | claude-b → claude-a → cursor → codex |\n'
  '| 1 — domain agents | …→ codex → **opencode** |\n'
  '| 2 — workers | **opencode** → ollama → claude-b → claude-a |\n\n'
  'Tier 0 is three Opus 5 rungs then GPT-5.6 Sol. Tier 2 leads with the free\n'
  'brain by design — that tier runs in bulk and unattended, which is where\n'
  'spending plan headroom is least defensible.\n\n'
  '## Make work free by making it tier 2\n\n'
  'A mission owned by a tier-2 agent plans *and* executes on the free brain.\n'
  'Measured: an 8-step mission, 9 sessions, total cost **0.0000 USD**.\n\n'
  '```bash\n'
  'curl -X POST http://127.0.0.1:8787/api/missions -H "content-type: application/json" \\\n'
  '  -d ''{"title":"...","objective":"...","agent":"scratch-worker","workingDir":"..."}''\n'
  '```\n\n'
  '## Caveats\n\n'
  '- ~30s per turn, nearly all CLI start-up. Fine unattended, wrong for anything\n'
  '  a human is waiting on.\n'
  '- Only `opencode/big-pickle` works. `minimax-m2.5-free` and `gpt-5-nano`\n'
  '  return server errors; `github-copilot/*` needs a Copilot seat the account\n'
  '  does not have.\n'
  '- Routing lives in `routing_policies.brain_chain`, which **overrides**\n'
  '  `brain_accounts.priority`. Changing priority alone changes nothing for any\n'
  '  agent that has a policy — and every tier has one.',
  ARRAY['models','cost','routing','missions'],
  'authored'
)
ON CONFLICT (name) DO NOTHING;
