-- 020_telemetry.sql
--
-- Machine telemetry, sampled over time.
--
-- Motivated by a specific instruction: "investigate and fix the cause rather
-- than repeatedly restarting". You cannot diagnose a leak from a single
-- snapshot — a process at 574 MB is either fine or halfway through leaking, and
-- only a trend distinguishes them. This table is what makes that answerable.
--
-- Deliberately coarse: per-process-group totals every few minutes, not
-- per-process every second. The question is "is something growing without
-- bound", and that needs hours of history rather than fine resolution.

CREATE TABLE system_samples (
    id              bigserial PRIMARY KEY,
    ts              timestamptz NOT NULL DEFAULT now(),

    free_mb         int NOT NULL,
    total_mb        int NOT NULL,
    pagefile_free_mb int,

    -- Grouped by what the process is, so growth can be attributed. A renderer
    -- climbing while everything else is flat is a very different problem from
    -- everything climbing together.
    claude_desktop_mb int,
    claude_code_mb    int,
    simba_mb          int,
    ollama_mb         int,
    postgres_mb       int,
    other_top_mb      int,

    process_count   int,
    detail          jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX system_samples_ts_idx ON system_samples (ts DESC);

-- Growth over the last six hours per group. A positive slope that does not
-- flatten is the signature worth acting on.
CREATE OR REPLACE VIEW memory_trend AS
WITH bounds AS (
    SELECT
        min(ts) FILTER (WHERE ts > now() - interval '6 hours') AS from_ts,
        max(ts)                                               AS to_ts
      FROM system_samples
),
first_s AS (
    SELECT s.* FROM system_samples s, bounds b WHERE s.ts = b.from_ts LIMIT 1
),
last_s AS (
    SELECT s.* FROM system_samples s, bounds b WHERE s.ts = b.to_ts LIMIT 1
)
SELECT
    f.ts                                        AS since,
    l.ts                                        AS until,
    l.free_mb - f.free_mb                       AS free_delta_mb,
    l.claude_desktop_mb - f.claude_desktop_mb   AS claude_desktop_delta_mb,
    l.claude_code_mb    - f.claude_code_mb      AS claude_code_delta_mb,
    l.simba_mb          - f.simba_mb            AS simba_delta_mb,
    l.ollama_mb         - f.ollama_mb           AS ollama_delta_mb,
    l.claude_desktop_mb                         AS claude_desktop_now_mb,
    l.free_mb                                   AS free_now_mb
  FROM first_s f, last_s l;
