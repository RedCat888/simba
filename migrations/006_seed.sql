-- 006_seed.sql
-- Initial roster. Everything here is ordinary data and is meant to be edited
-- by UPDATE rather than by changing this file.

-- ---------------------------------------------------------------------------
-- Nodes
-- ---------------------------------------------------------------------------
INSERT INTO nodes (id, slug, name, platform, hostname, is_primary, status, capabilities) VALUES
    ('22222222-2222-2222-2222-222222222201', 'odium', 'Windows desktop (i5-14600K / RTX 3070)',
     'windows', 'PROJECT-ODIUM', true, 'online',
     '{"gpu":"RTX 3070","runs_sessions":true,"hosts_postgres":true,"hosts_gateway":true}'::jsonb),
    ('22222222-2222-2222-2222-222222222202', 'macbook', 'MacBook Air M4',
     'darwin', NULL, false, 'offline',
     '{"runs_sessions":false,"reachable_only":true}'::jsonb);

-- ---------------------------------------------------------------------------
-- Brain accounts.
--
-- claude-a points at the existing config dir so the account already logged in
-- keeps working untouched. claude-b gets its own directory and is seeded as
-- logged_out until the operator completes the login; the supervisor skips any brain
-- that is not 'available', so an unlogged account is inert rather than broken.
--
-- Config dirs deliberately live outside the repo: they hold credentials.
-- ---------------------------------------------------------------------------
INSERT INTO brain_accounts
    (id, slug, label, provider, kind, cli, config_dir, tier_models, priority, status) VALUES
    ('11111111-1111-1111-1111-111111111101', 'claude-a', 'Claude subscription A',
     'anthropic', 'subscription', 'claude', 'C:\Users\operator\.claude',
     '{"high":"opus","mid":"sonnet","cheap":"haiku"}'::jsonb, 10, 'unverified'),

    ('11111111-1111-1111-1111-111111111102', 'claude-b', 'Claude subscription B',
     'anthropic', 'subscription', 'claude', 'C:\Users\operator\.simba-brains\claude-b',
     '{"high":"opus","mid":"sonnet","cheap":"haiku"}'::jsonb, 20, 'logged_out'),

    -- Model ids taken from the account's own models_cache.json, not guessed.
    -- A ChatGPT subscription rejects models it does not serve outright
    -- ("not supported when using Codex with a ChatGPT account"), so an invented
    -- id fails the turn rather than degrading. gpt-5.6-terra is the top tier
    -- and is what config.toml already selects.
    ('11111111-1111-1111-1111-111111111103', 'codex', 'ChatGPT Plus (Codex CLI)',
     'openai', 'subscription', 'codex', 'C:\Users\operator\.codex',
     '{"high":"gpt-5.6-terra","mid":"gpt-5.6-luna","cheap":"gpt-5.4-mini"}'::jsonb, 30, 'unverified'),

    ('11111111-1111-1111-1111-111111111104', 'cursor', 'Cursor subscription',
     'cursor', 'subscription', 'cursor-agent', NULL,
     '{"high":"opus","mid":"sonnet","cheap":"haiku"}'::jsonb, 40, 'unverified');

-- ---------------------------------------------------------------------------
-- Permission profiles.
--
-- Posture is bypass-everything. The deny list is scoped to exactly what the operator
-- approved: core disk, OS, boot and registry operations — the things that can
-- leave the machine unbootable and that no amount of retrying recovers from.
-- These are enforced by the runner against the command string before dispatch,
-- not by asking the model to be careful.
--
-- confirm_patterns is intentionally empty. Approval prompts were the thing
-- this system exists to eliminate; the deny list is the whole safety surface.
-- ---------------------------------------------------------------------------
INSERT INTO permission_profiles (id, slug, name, bypass_all, deny_patterns, confirm_patterns) VALUES
    ('33333333-3333-3333-3333-333333333301', 'default', 'Full access, core-OS denied', true,
     ARRAY[
        '(?i)\bdiskpart\b',
        '(?i)\bformat\s+[a-z]:',
        '(?i)\b(bcdedit|bcdboot|bootrec|bootsect)\b',
        '(?i)\bfsutil\b',
        '(?i)\bmountvol\b[^\n]*\s/d\b',
        '(?i)\bvssadmin\b[^\n]*\bdelete\b',
        '(?i)\bwbadmin\b[^\n]*\bdelete\b',
        '(?i)\b(Clear-Disk|Initialize-Disk|Remove-Partition|Set-Partition|Format-Volume)\b',
        '(?i)\breg(\.exe)?\s+(delete|add)\b[^\n]*\bHK(LM|EY_LOCAL_MACHINE|U|EY_USERS|CR|EY_CLASSES_ROOT)\b',
        '(?i)\b(Remove-Item|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|New-Item)\b[^\n]*\bHK(LM|CR|U):',
        '(?i)\bRemove-Item\b[^\n]*\bC:\\+Windows\b',
        '(?i)\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+/(\s|$)',
        '(?i)\bsc(\.exe)?\s+delete\b',
        '(?i)\bbcdedit\b'
     ]::text[],
     ARRAY[]::text[]),

    -- Intake evaluation of repos arriving from Instagram. Same bypass posture,
    -- but credentials are not injected into these sessions.
    ('33333333-3333-3333-3333-333333333302', 'intake', 'Intake evaluation (no host credentials)', true,
     ARRAY[
        '(?i)\bdiskpart\b',
        '(?i)\bformat\s+[a-z]:',
        '(?i)\b(bcdedit|bcdboot|bootrec|bootsect)\b',
        '(?i)\bfsutil\b',
        '(?i)\b(Clear-Disk|Initialize-Disk|Remove-Partition|Set-Partition|Format-Volume)\b',
        '(?i)\breg(\.exe)?\s+(delete|add)\b[^\n]*\bHK(LM|EY_LOCAL_MACHINE)\b',
        '(?i)\b(Remove-Item|Set-ItemProperty|New-Item)\b[^\n]*\bHK(LM|CR|U):',
        '(?i)\bRemove-Item\b[^\n]*\bC:\\+Windows\b'
     ]::text[],
     ARRAY[]::text[]);

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
INSERT INTO projects (id, slug, name, kind, root_path, node_id) VALUES
    ('44444444-4444-4444-4444-444444444401', 'simba', 'Simba itself', 'repo',
     'C:\Users\operator\simba', '22222222-2222-2222-2222-222222222201'),
    ('44444444-4444-4444-4444-444444444402', 'reel-agent', 'Instagram intake (legacy ReelAgent)', 'local',
     'C:\Users\operator\ReelAgent', '22222222-2222-2222-2222-222222222201'),
    ('44444444-4444-4444-4444-444444444403', 'atlas', 'Atlas project inventory', 'repo',
     'C:\Users\operator\Downloads\atlas', '22222222-2222-2222-2222-222222222201');

-- ---------------------------------------------------------------------------
-- The roster.
--
-- Simba is tier 0 and runs at the high tier. Every tier-1 agent is created
-- with a model_tier that Simba is free to change: deciding whether a given
-- agent needs a high or mid brain is Simba's call, expressed as an UPDATE.
-- ---------------------------------------------------------------------------
INSERT INTO agents
    (id, slug, name, tier, domain, description, project_id, node_id,
     preferred_cli, model_tier, brain_chain, permission_profile_id, status) VALUES

    ('55555555-5555-5555-5555-555555555501', 'simba', 'Simba', 0, 'meta',
     'Admin and manager. Owns the roster, routes work, answers questions about the whole system''s history. Rarely writes code.',
     '44444444-4444-4444-4444-444444444401', '22222222-2222-2222-2222-222222222201',
     'claude', 'high',
     ARRAY['11111111-1111-1111-1111-111111111101',
           '11111111-1111-1111-1111-111111111102',
           '11111111-1111-1111-1111-111111111103']::uuid[],
     '33333333-3333-3333-3333-333333333301', 'idle'),

    ('55555555-5555-5555-5555-555555555502', 'instagram-intake', 'Instagram Intake', 1, 'intake',
     'Picks up reels, posts, threads and repo links shared to the intake account; analyzes and routes them.',
     '44444444-4444-4444-4444-444444444402', '22222222-2222-2222-2222-222222222201',
     'claude', 'mid', ARRAY[]::uuid[],
     '33333333-3333-3333-3333-333333333302', 'idle'),

    ('55555555-5555-5555-5555-555555555503', 'windows-admin', 'Windows Admin', 1, 'ops',
     'Filesystem, installed apps, power configuration, scheduled tasks and day-to-day administration of this PC.',
     NULL, '22222222-2222-2222-2222-222222222201',
     'claude', 'mid', ARRAY[]::uuid[],
     '33333333-3333-3333-3333-333333333301', 'idle'),

    ('55555555-5555-5555-5555-555555555504', 'network', 'Network & Infra', 1, 'infra',
     'Proxies, tunnels, Cloudflare, local services and connectivity.',
     NULL, '22222222-2222-2222-2222-222222222201',
     'claude', 'mid', ARRAY[]::uuid[],
     '33333333-3333-3333-3333-333333333301', 'idle'),

    ('55555555-5555-5555-5555-555555555505', 'gameservers', 'Game Servers', 1, 'gameservers',
     'Exaroton Paper/Minecraft server, the squaremap web map and its Cloudflare/R2 sync.',
     NULL, '22222222-2222-2222-2222-222222222201',
     'claude', 'cheap', ARRAY[]::uuid[],
     '33333333-3333-3333-3333-333333333301', 'idle');

-- ---------------------------------------------------------------------------
-- Routing policy.
--
-- Both Claude accounts come first because same-tool failover is a transcript
-- file copy plus a resume — near-lossless. Codex and Cursor sit behind them
-- because reaching either means a lossy cross-tool rehydration.
--
-- When the whole chain is exhausted the default is to sleep until the earliest
-- reset rather than to stop: work resumes on its own.
-- ---------------------------------------------------------------------------
INSERT INTO routing_policies
    (slug, name, applies_to_tier, model_tier, brain_chain, on_exhausted, priority) VALUES
    ('tier0-default', 'Simba: high tier, Claude first', 0, 'high',
     ARRAY['11111111-1111-1111-1111-111111111101',
           '11111111-1111-1111-1111-111111111102',
           '11111111-1111-1111-1111-111111111103']::uuid[],
     'escalate', 10),

    ('tier1-default', 'Tier 1: full chain, sleep when exhausted', 1, NULL,
     ARRAY['11111111-1111-1111-1111-111111111101',
           '11111111-1111-1111-1111-111111111102',
           '11111111-1111-1111-1111-111111111103',
           '11111111-1111-1111-1111-111111111104']::uuid[],
     'sleep_until_reset', 20),

    ('tier2-default', 'Workers: cheap tier, any brain', 2, 'cheap',
     ARRAY['11111111-1111-1111-1111-111111111101',
           '11111111-1111-1111-1111-111111111102',
           '11111111-1111-1111-1111-111111111103',
           '11111111-1111-1111-1111-111111111104']::uuid[],
     'sleep_until_reset', 30);

-- ---------------------------------------------------------------------------
-- Knowledge sources, registered empty. The ingest pipeline fills them.
-- ---------------------------------------------------------------------------
INSERT INTO knowledge_sources (slug, kind, name, uri) VALUES
    ('obsidian',       'obsidian',       'Obsidian vault',
     'C:\Users\operator\OneDrive\Documents\Obsidian Vault'),
    ('knowledge-api',  'knowledge_api',  'Personal knowledge vector DB',
     'https://knowledge-api.operatori-operator.workers.dev'),
    ('chatgpt-export', 'chatgpt_export', 'ChatGPT conversation export', NULL),
    ('claude-export',  'claude_export',  'Claude conversation export', NULL),
    ('session-history','session_history','Simba''s own session transcripts', NULL);
