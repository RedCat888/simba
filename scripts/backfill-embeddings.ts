/**
 * Embeds the three owner kinds recall already joins but nothing ever wrote.
 *
 * recall() has LEFT JOINs for summary, document_revision and checkpoint, and
 * the embeddings table has never contained a single row of any of them - so
 * Simba could search the knowledge corpus and its own extracted decisions, but
 * not its own session history, documents or handoffs. The joins were written
 * for a capability that was never finished.
 *
 * This was skipped earlier tonight as too expensive: 1,409 rows, and the
 * standing instruction is to prefer real bugs over new surface. Pruning the
 * handoff snapshots took document_revisions from 1,267 rows to 63, which drops
 * the whole job to about 205 embeddings - minutes on local Ollama, no API
 * spend, nothing user-facing to undo.
 *
 * Each kind embeds exactly the column recall displays for it, so a hit's text
 * is the text that made it match. Rows with nothing to say are skipped rather
 * than embedded as empty strings.
 *
 * Idempotent: already-embedded owners are left alone, so it can be re-run.
 *
 *   npx tsx scripts/backfill-embeddings.ts
 */
import { embed, toVectorLiteral } from '../src/knowledge/embed.js';
import { query, closePool } from '../src/db/index.js';
import { config } from '../src/config.js';

type Row = { id: string; content: string };

const KINDS: Array<{ kind: string; sql: string }> = [
  { kind: 'summary',
    sql: `SELECT s.id, s.summary AS content FROM summaries s
           WHERE coalesce(s.summary,'') <> ''
             AND NOT EXISTS (SELECT 1 FROM embeddings e
                              WHERE e.owner_kind='summary' AND e.owner_id=s.id)` },
  { kind: 'document_revision',
    sql: `SELECT dr.id, dr.content FROM document_revisions dr
           WHERE coalesce(dr.content,'') <> ''
             AND NOT EXISTS (SELECT 1 FROM embeddings e
                              WHERE e.owner_kind='document_revision' AND e.owner_id=dr.id)` },
  { kind: 'checkpoint',
    sql: `SELECT c.id, c.work_done AS content FROM checkpoints c
           WHERE coalesce(c.work_done,'') <> ''
             AND NOT EXISTS (SELECT 1 FROM embeddings e
                              WHERE e.owner_kind='checkpoint' AND e.owner_id=c.id)` },
];

// 2,000 characters, which is what chunkText already proves works.
//
// nomic-embed-text has a 2,048-token context and answers an over-long input
// with HTTP 500 "the input length exceeds the context length" rather than
// truncating. Documents here run to 46,826 characters against a 5,007 median,
// and the batch of 32 is embedded in one request, so the ceiling is on the
// batch rather than the item. Knowledge chunks are capped at 2,400 by
// chunkText and embed through this same path every day, so matching that is
// the size known to be safe rather than the one that looked reasonable.
//
// A document's opening 2,000 characters are what say which document it is,
// which is what retrieval needs from it.
const MAX_CHARS = 2000;
const BATCH = config.embedding.batchSize;

let total = 0;
for (const { kind, sql } of KINDS) {
  const rows = await query<Row>(sql);
  if (rows.length === 0) { console.log(`  ${kind.padEnd(18)} nothing to do`); continue; }

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const texts = batch.map((r) => r.content.slice(0, MAX_CHARS));
    let vectors: number[][];
    try {
      vectors = await embed(texts);
    } catch (err) {
      console.error(`  ${kind}: embedding failed at row ${i}:`, err instanceof Error ? err.message : err);
      break;
    }
    for (let j = 0; j < batch.length; j += 1) {
      const row = batch[j]; const vec = vectors[j];
      if (!row || !vec) continue;
      await query(
        `INSERT INTO embeddings (owner_kind, owner_id, model, dim, embedding)
         VALUES ($1,$2,$3,$4,$5::vector)
         ON CONFLICT (owner_kind, owner_id, model)
         DO UPDATE SET embedding = EXCLUDED.embedding`,
        [kind, row.id, config.embedding.model, config.embedding.dim, toVectorLiteral(vec)],
      );
      done += 1;
    }
  }
  console.log(`  ${kind.padEnd(18)} embedded ${done} of ${rows.length}`);
  total += done;
}
console.log(`  total: ${total}`);
await closePool();
