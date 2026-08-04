-- Give the already-failed sessions their reason back.
--
-- Six sessions sat at status 'failed' with error IS NULL. The exit code was
-- recorded all along, but only as an event message — so the app showed a bare
-- "failed" with no explanation, which reads as a defect in Simba rather than
-- something that happened to a process. The information existed; nothing joined
-- it to the row anyone actually looks at.
--
-- Windows reports crashes as large unsigned NTSTATUS values, which is why the
-- log said code=3221226505 rather than anything meaningful. That is 0xC0000409,
-- a fatal runtime check failure — the CLI crashed. Decoding it here matches what
-- describeExit() in the engine now writes for new sessions, so old and new rows
-- read the same way.
UPDATE sessions s
   SET error = sub.reason
  FROM (
    SELECT DISTINCT ON (e.session_id)
           e.session_id,
           CASE substring(e.message from 'code=([0-9]+)')
             WHEN '3221226505' THEN 'stack buffer overrun / fatal runtime check — the CLI crashed (0xC0000409)'
             WHEN '3221225477' THEN 'access violation — the CLI crashed (0xC0000005)'
             WHEN '3221225725' THEN 'stack overflow — the CLI crashed (0xC00000FD)'
             WHEN '3221226356' THEN 'heap corruption — the CLI crashed (0xC0000374)'
             WHEN '4294967295' THEN 'exited -1 — generic failure, no diagnostic given'
             ELSE 'exited with code ' || substring(e.message from 'code=([0-9]+)')
           END AS reason
      FROM events e
     WHERE e.type = 'session.exit'
       AND e.message LIKE '%code=%'
       AND substring(e.message from 'code=([0-9]+)') <> '0'
     ORDER BY e.session_id, e.ts DESC
  ) AS sub
 WHERE s.id = sub.session_id
   AND s.status = 'failed'
   AND s.error IS NULL;
