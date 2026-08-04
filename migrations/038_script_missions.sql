-- Scheduled work that needs no model.
--
-- Taken from Hermes' script-only cron mode. Plenty of recurring work is a
-- command, not a judgement: back something up, sync a folder, publish a build,
-- check a service. Routing that through an agent costs a model call, a session,
-- a concurrency slot and a planning round to produce output a shell already
-- produces, and adds a failure mode - the model deciding to do something
-- slightly different this time.
--
-- When `script` is set the executor runs it directly and records stdout as the
-- result. No planning, no session, no tokens.
ALTER TABLE missions ADD COLUMN IF NOT EXISTS script text;

-- Which interpreter. PowerShell is the default because this is Windows and it
-- is what the rest of the system assumes.
ALTER TABLE missions ADD COLUMN IF NOT EXISTS script_shell text
  CHECK (script_shell IS NULL OR script_shell IN ('powershell', 'bash', 'cmd'));

-- The last run's output, so a scheduled script is inspectable from the phone
-- without going to the machine.
ALTER TABLE missions ADD COLUMN IF NOT EXISTS last_output text;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS last_exit_code integer;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS last_run_at timestamptz;
