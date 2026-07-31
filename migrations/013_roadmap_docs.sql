-- 013_roadmap_docs.sql
-- Persists the external architecture review into the documents table.
--
-- Deliberately not a markdown file: this is operational state — a decision
-- input that agents should be able to search and cite — rather than notes about
-- an external repo. It is copied from the session transcript so provenance
-- stays intact and the review can be traced back to the session that produced
-- it.

WITH src AS (
    SELECT m.content, s.id AS session_id, s.agent_id
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
     WHERE s.id = 'bb03c337-2d6e-4705-b38f-de7b7e147e48'
       AND m.role = 'assistant'
       AND m.content IS NOT NULL
       AND length(m.content) > 500
     ORDER BY m.seq DESC
     LIMIT 1
),
doc AS (
    INSERT INTO documents (slug, kind, scope, title, current_revision)
    SELECT 'architecture-review-gpt56', 'analysis', 'global',
           'External architecture review (gpt-5.6-terra)', 1
      FROM src
    ON CONFLICT DO NOTHING
    RETURNING id
)
INSERT INTO document_revisions (document_id, revision, content, summary, author_session_id)
SELECT doc.id, 1, src.content,
       'Independent review by gpt-5.6-terra via the Codex brain. Flagged: transcript-copy '
    || 'failover is brittle against undocumented formats; a tunnel converts full-perms into '
    || 'a remote-authority surface; and no side-effect execution model existed, so failover '
    || 'and auto-resume could re-run external actions.',
       src.session_id
  FROM doc, src;
