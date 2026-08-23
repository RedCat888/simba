-- Disk, because nothing was watching it and it reached zero.
--
-- On 22 August C: filled completely mid-session. git failed with "No space left
-- on device" and could not even write its index lock, so a commit was lost;
-- Postgres, which stores everything Simba knows, was one write away from the
-- same wall. Telemetry samples free RAM, commit charge and per-process memory
-- every five minutes and had nothing at all to say about it.
--
-- It is the cheapest of the three to check and the most total when it runs out:
-- RAM pressure makes things slow, commit exhaustion stops new processes, a full
-- disk stops writes - and a database that cannot write is a system that cannot
-- remember.

ALTER TABLE system_samples
    ADD COLUMN IF NOT EXISTS disk_free_mb  bigint,
    ADD COLUMN IF NOT EXISTS disk_total_mb bigint;

COMMENT ON COLUMN system_samples.disk_free_mb IS
    'Free bytes on the volume holding the Postgres data directory, in MB.';
COMMENT ON COLUMN system_samples.disk_total_mb IS
    'Total size of that volume, in MB. Free alone cannot say whether 50GB is comfortable.';
