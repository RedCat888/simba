-- Commit charge, because free physical memory does not predict what the
-- telemetry exists to predict.
--
-- On 17 August the machine reported 13 GB of 32 GB physical free, and a JVM
-- could not reserve 32 MB — Gradle failed with "_beginthreadex failed (EINVAL)"
-- and the Android tests could not be run at all. Commit was at 99.99% of a
-- 40.7 GB limit: every reservation had been handed out, so a new thread stack
-- had nowhere to come from even though the RAM to back it was sitting idle.
--
-- free_mb read healthy through the whole thing. It measures the wrong ceiling.
-- Simba spawns agent CLI processes, so this is the ceiling that stops it
-- working, and it is the one nothing was recording.

ALTER TABLE system_samples
    ADD COLUMN IF NOT EXISTS commit_used_mb  integer,
    ADD COLUMN IF NOT EXISTS commit_limit_mb integer;

COMMENT ON COLUMN system_samples.commit_used_mb IS
    'Windows committed bytes: memory promised to processes, backed by RAM or pagefile.';
COMMENT ON COLUMN system_samples.commit_limit_mb IS
    'RAM + current pagefile size. Allocations fail at this ceiling regardless of free RAM.';
