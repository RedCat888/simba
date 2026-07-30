import { query, one, transaction, recordEvent } from '../db/index.js';
import { embed, toVectorLiteral } from '../knowledge/embed.js';
import { chunkText } from './chunk.js';
import { hashContent, type IngestItem } from './sources.js';
import { config } from '../config.js';

/**
 * Ingest orchestration: store item, chunk, embed, index.
 *
 * Idempotent by content hash. Re-running against a growing export directory
 * only does work for what actually changed, which matters because these
 * sources are re-exported periodically rather than streamed.
 */

export interface IngestStats {
  seen: number;
  inserted: number;
  updated: number;
  skipped: number;
  chunks: number;
  embedded: number;
  errors: number;
}

export async function ingestSource(
  sourceSlug: string,
  items: AsyncIterable<IngestItem>,
  opts: { embedChunks?: boolean; onProgress?: (s: IngestStats) => void } = {},
): Promise<IngestStats> {
  const source = await one<{ id: string }>(
    `SELECT id FROM knowledge_sources WHERE slug = $1`,
    [sourceSlug],
  );
  if (!source) throw new Error(`unknown knowledge source: ${sourceSlug}`);

  const stats: IngestStats = {
    seen: 0, inserted: 0, updated: 0, skipped: 0, chunks: 0, embedded: 0, errors: 0,
  };

  const pendingEmbeds: Array<{ chunkId: string; content: string }> = [];

  for await (const item of items) {
    stats.seen += 1;
    try {
      const hash = hashContent(item.content);

      const existing = await one<{ id: string; content_hash: string }>(
        `SELECT id, content_hash FROM knowledge_items
          WHERE source_id = $1 AND external_id = $2`,
        [source.id, item.externalId],
      );

      if (existing && existing.content_hash === hash) {
        stats.skipped += 1;
        continue;
      }

      const itemId = await transaction(async (client) => {
        if (existing) {
          await client.query(
            `UPDATE knowledge_items
                SET title = $2, content = $3, category = $4, tags = $5,
                    metadata = $6, content_hash = $7, source_created_at = $8
              WHERE id = $1`,
            [
              existing.id, item.title, item.content, item.category ?? null,
              item.tags ?? [], JSON.stringify(item.metadata ?? {}), hash,
              item.sourceCreatedAt ?? null,
            ],
          );
          // Content changed, so every derived chunk and embedding is stale.
          await client.query(`DELETE FROM knowledge_chunks WHERE item_id = $1`, [existing.id]);
          return existing.id;
        }

        const created = await client.query<{ id: string }>(
          `INSERT INTO knowledge_items
             (source_id, external_id, title, content, category, tags, metadata,
              content_hash, source_created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            source.id, item.externalId, item.title, item.content, item.category ?? null,
            item.tags ?? [], JSON.stringify(item.metadata ?? {}), hash,
            item.sourceCreatedAt ?? null,
          ],
        );
        return created.rows[0]!.id;
      });

      if (existing) stats.updated += 1;
      else stats.inserted += 1;

      for (const chunk of chunkText(item.content)) {
        const row = await one<{ id: string }>(
          `INSERT INTO knowledge_chunks (item_id, chunk_index, content, token_count)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (item_id, chunk_index) DO UPDATE SET content = EXCLUDED.content
           RETURNING id`,
          [itemId, chunk.index, chunk.content, chunk.tokenEstimate],
        );
        stats.chunks += 1;
        if (row && opts.embedChunks !== false) {
          pendingEmbeds.push({ chunkId: row.id, content: chunk.content });
        }
      }

      if (pendingEmbeds.length >= config.embedding.batchSize * 4) {
        stats.embedded += await flushEmbeddings(pendingEmbeds);
        opts.onProgress?.(stats);
      }
    } catch (err) {
      stats.errors += 1;
      console.error(`[ingest] ${sourceSlug}/${item.externalId}:`, err instanceof Error ? err.message : err);
    }
  }

  if (pendingEmbeds.length > 0) {
    stats.embedded += await flushEmbeddings(pendingEmbeds);
  }

  await query(
    `UPDATE knowledge_sources
        SET last_ingested_at = now(),
            item_count = (SELECT count(*) FROM knowledge_items WHERE source_id = $1)
      WHERE id = $1`,
    [source.id],
  );

  await recordEvent({
    type: 'ingest.completed',
    message: `${sourceSlug}: +${stats.inserted} new, ${stats.updated} updated, ${stats.skipped} unchanged, ${stats.embedded} embedded`,
    data: stats as unknown as Record<string, unknown>,
  });

  return stats;
}

async function flushEmbeddings(pending: Array<{ chunkId: string; content: string }>): Promise<number> {
  if (pending.length === 0) return 0;
  const batch = pending.splice(0, pending.length);

  let vectors: number[][];
  try {
    vectors = await embed(batch.map((b) => b.content));
  } catch (err) {
    // Ingest is still valuable without vectors — the text is stored and
    // literal search works. Recall degrades; nothing is lost.
    console.error('[ingest] embedding failed, continuing without vectors:', err instanceof Error ? err.message : err);
    return 0;
  }

  let n = 0;
  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];
    const vector = vectors[i];
    if (!item || !vector) continue;
    await query(
      `INSERT INTO embeddings (owner_kind, owner_id, model, dim, embedding, content_hash)
       VALUES ('knowledge_chunk', $1, $2, $3, $4::vector, $5)
       ON CONFLICT (owner_kind, owner_id, model)
       DO UPDATE SET embedding = EXCLUDED.embedding, content_hash = EXCLUDED.content_hash`,
      [item.chunkId, config.embedding.model, config.embedding.dim,
       toVectorLiteral(vector), hashContent(item.content)],
    );
    n += 1;
  }
  return n;
}
