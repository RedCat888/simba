import { config } from '../config.js';
import { query } from '../db/index.js';

/**
 * Local embeddings via Ollama. Chosen over a hosted embedding endpoint because
 * embedding a full personal archive — years of chat exports plus a vault — would
 * otherwise require an API key and real per-token spend, which the whole system
 * is built to avoid.
 */

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += config.embedding.batchSize) {
    const batch = texts.slice(i, i + config.embedding.batchSize);
    const results = await Promise.all(batch.map((t) => embedOne(t)));
    out.push(...results);
  }
  return out;
}

async function embedOne(text: string): Promise<number[]> {
  const res = await fetch(`${config.embedding.endpoint}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.embedding.model, prompt: text.slice(0, 8000) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`embedding failed (${res.status}): ${await res.text().catch(() => '')}`);
  }
  const body = (await res.json()) as { embedding?: number[] };
  if (!Array.isArray(body.embedding)) throw new Error('embedding response missing vector');
  if (body.embedding.length !== config.embedding.dim) {
    throw new Error(
      `embedding dim mismatch: got ${body.embedding.length}, schema expects ${config.embedding.dim}`,
    );
  }
  return body.embedding;
}

/** pgvector literal format. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

export interface RecallHit {
  owner_kind: string;
  owner_id: string;
  content: string;
  title: string | null;
  source: string | null;
  distance: number;
}

/**
 * Why the last recall came back empty, when the reason was not "nothing matched".
 *
 * Deliberately a module-level note rather than a thrown error: recall's contract
 * with hydration is that it never fails a bundle, and changing that to serve the
 * search box would trade a visible problem for an invisible one somewhere else.
 */
let lastRecallFailure: { at: number; reason: string; stage: 'embed' | 'query' } | null = null;

/**
 * Null when recall is working. Cleared by the next success.
 *
 * `stage` matters to whoever reads it: an embed failure means start Ollama, a
 * query failure means something is wrong with Postgres or pgvector, and telling
 * someone to start Ollama when the database is the problem sends them away from
 * the fault.
 */
export function recallFailure(): { at: number; reason: string; stage: 'embed' | 'query' } | null {
  return lastRecallFailure;
}

/**
 * Semantic recall across the knowledge corpus and Simba's own history.
 * Returns nothing rather than throwing when embeddings are unavailable —
 * recall is an enhancement to a hydration bundle, never a precondition for one.
 */
export async function recall(
  queryText: string,
  opts: { limit?: number; agentId?: string | null; ownerKinds?: string[] } = {},
): Promise<RecallHit[]> {
  let vector: number[];
  try {
    [vector] = (await embed([queryText])) as [number[]];
  } catch (err) {
    // Still returns nothing rather than throwing — hydration genuinely does not
    // care, which is what the doc comment above is about. But it says so now,
    // because one caller does care very much: a person typed a query into a
    // search box and pressed a button. Ollama was down for an unknown stretch
    // and every search answered "No matches", which is a different sentence
    // from "the search engine is not running" and sent the reader looking for
    // the wrong problem.
    lastRecallFailure = { at: Date.now(), reason: String((err as Error).message ?? err), stage: 'embed' };
    return [];
  }
  if (!vector) return [];
  lastRecallFailure = null;

  const limit = opts.limit ?? 8;
  const kinds = opts.ownerKinds ?? null;

  try {
    return await query<RecallHit>(
      `SELECT e.owner_kind,
              e.owner_id,
              COALESCE(kc.content, dc.statement, s.summary, dr.content, cp.work_done, '') AS content,
              COALESCE(ki.title, dc.topic, s.title)                                        AS title,
              COALESCE(ks.slug, 'simba')                                     AS source,
              (e.embedding <=> $1::vector)                                   AS distance
         FROM embeddings e
         LEFT JOIN knowledge_chunks   kc ON e.owner_kind = 'knowledge_chunk'   AND kc.id = e.owner_id
         LEFT JOIN knowledge_items    ki ON ki.id = kc.item_id
         LEFT JOIN knowledge_sources  ks ON ks.id = ki.source_id
         -- decisions were embedded and never joined.
         --
         -- The embeddings table holds exactly two owner kinds: knowledge_chunk
         -- and decision. This query had joins for four, and decision was not
         -- among them, so every one of the 1,049 decision vectors returned an
         -- empty content string and a null title. They are searchable, rank
         -- normally against the chunks, and then render as a blank row.
         --
         -- askDecisions escaped it by re-fetching each hit by id and using
         -- recall only for ranking, which is why the dedicated feature works
         -- and the general search box does not.
         LEFT JOIN decisions          dc ON e.owner_kind = 'decision'          AND dc.id = e.owner_id
         LEFT JOIN summaries          s  ON e.owner_kind = 'summary'           AND s.id  = e.owner_id
         LEFT JOIN document_revisions dr ON e.owner_kind = 'document_revision' AND dr.id = e.owner_id
         LEFT JOIN checkpoints        cp ON e.owner_kind = 'checkpoint'        AND cp.id = e.owner_id
        WHERE ($2::text[] IS NULL OR e.owner_kind = ANY($2::text[]))
          AND ($3::uuid IS NULL OR e.agent_id = $3::uuid OR e.agent_id IS NULL)
        ORDER BY e.embedding <=> $1::vector
        LIMIT $4`,
      [toVectorLiteral(vector), kinds, opts.agentId ?? null, limit],
    );
  } catch (err) {
    // Recorded for the same reason the embed failure above is, and it was not.
    //
    // Half of this function reported why it came back empty and half of it did
    // not. A failing recall query - pgvector unavailable, a bad parameter, the
    // connection dropping - produced exactly the sentence the embed path was
    // fixed to stop producing: "No matches", against thirty thousand vectors,
    // with nothing to say otherwise.
    lastRecallFailure = { at: Date.now(), reason: String((err as Error).message ?? err), stage: 'query' };
    return [];
  }
}
