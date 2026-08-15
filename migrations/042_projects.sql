-- What state each project is in, and which of it is one disk failure from gone.
--
-- the operator built atlas before Simba and described it as "an operational index:
-- what exists, where it lives, what state it's in, what's risky, and what to do
-- next". Simba already had "what exists" — `projects` has been here since
-- 002_core as the durable scope an agent owns — and it gained "what to do next"
-- with the requests table. What it never had was state: the row said where a
-- project lived and nothing about whether the work inside it still existed
-- anywhere else.
--
-- These columns are deliberately the only ones added. A project record that
-- tries to describe what something *is* goes stale the week it is written and
-- nobody updates it. What does not go stale, and what nothing else here
-- answers, is where work sits in exactly one place: uncommitted edits, and
-- commits that are on this disk and nowhere else. That is the same class of
-- loss the worktree reaper exists for, at the scale of the whole machine — and
-- the reaper spent days reporting it wrongly, which is a fair warning about how
-- quietly this kind of thing goes wrong.
ALTER TABLE projects
    ADD COLUMN branch          text,
    ADD COLUMN dirty_files     integer NOT NULL DEFAULT 0,
    ADD COLUMN unpushed        integer NOT NULL DEFAULT 0,
    ADD COLUMN last_commit_at  timestamptz,
    ADD COLUMN last_scanned_at timestamptz,
    -- Set when a scan could not read the repository at all, rather than
    -- silently recording zeroes. "Nothing at risk" and "could not tell" must
    -- never look the same, because the entire value of a zero here is being
    -- able to trust it.
    ADD COLUMN scan_error      text;

-- The scanner keys on the directory it found, so that has to be unique. Partial
-- because `projects` legitimately holds rows with no path at all — a domain, an
-- account, a piece of infrastructure — and those must not collide with each
-- other on NULL.
CREATE UNIQUE INDEX projects_root_path_key ON projects (root_path)
    WHERE root_path IS NOT NULL;

-- Read ordered by exposure, which is the only ordering that makes a list of
-- forty repositories worth opening twice.
CREATE INDEX projects_risk_idx ON projects ((dirty_files + unpushed) DESC)
    WHERE NOT archived;
