-- GitHub Copilot as a brain, parked until the account actually has a seat.
--
-- OpenCode already holds a working Copilot oauth credential, and its catalog
-- lists Sonnet 5, Opus 5, Gemini 3.x and GPT-5.2. If that seat becomes active
-- it is the best free tier available here by a wide margin — frontier models at
-- no cost against the plan.
--
-- It is not active. Three checks agree and are recorded here so this is not
-- re-diagnosed from scratch: the connected account is PROJECT_OWNER, its GitHub
-- plan reads "free" rather than Pro, and api.github.com/copilot_internal/v2/token
-- returns 404 for that token. Every model returns "Forbidden: unauthorized: not
-- licensed to use Copilot". The credential is fine; the entitlement is missing.
--
-- The row exists disabled rather than being left out, so the state is visible in
-- the app instead of living in a conversation. "verify" on it runs a real turn
-- and reports the real error, so the moment the seat lands it goes green and one
-- toggle enables it — no code change and nobody needs to remember this.
--
-- cli is 'opencode' because that is genuinely what runs it: Copilot here is a
-- provider reached through the OpenCode CLI, not a separate binary.
INSERT INTO brain_accounts (id, slug, label, provider, kind, cli, config_dir, env, tier_models, priority, enabled, status, last_error)
VALUES (
  '11111111-1111-1111-1111-111111111107',
  'copilot',
  'GitHub Copilot (via OpenCode)',
  'opencode',
  'free',
  'opencode',
  NULL,
  '{}'::jsonb,
  '{"high": "github-copilot/claude-opus-5", "mid": "github-copilot/claude-sonnet-5", "cheap": "github-copilot/claude-haiku-4.5", "free": "github-copilot/claude-sonnet-5"}'::jsonb,
  -- Below the Claude accounts, above cursor. Free models should displace paid
  -- ones, which argues for placing it first; Copilot meters "premium requests"
  -- on its own terms and how that interacts with sustained agent use is unknown
  -- here. 25 is the cautious position, and moving it is one number once the
  -- quota behaviour has been seen rather than guessed at.
  25,
  false,
  'logged_out',
  'account PROJECT_OWNER has no Copilot entitlement: GitHub plan is "free" and copilot_internal/v2/token returns 404. Claim Copilot Pro (Student Pack at education.github.com/benefits, then enable at github.com/settings/copilot), or re-authenticate OpenCode to whichever account holds it. Verify from the app once claimed.'
)
ON CONFLICT (slug) DO UPDATE SET
  tier_models = EXCLUDED.tier_models,
  last_error  = EXCLUDED.last_error,
  updated_at  = now();
