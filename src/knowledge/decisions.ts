import { query, one, recordEvent } from '../db/index.js';
import { cheapComplete } from '../hydration/cheap.js';
import { embed, toVectorLiteral, recall } from './embed.js';
import { config } from '../config.js';

/**
 * Decision extraction and recall.
 *
 * Semantic search over raw conversation returns deliberation. What is wanted
 * from "what did I decide about X" is the conclusion, and whether it still
 * holds. That requires pulling decisions out as their own objects, dating them,
 * and letting later ones supersede earlier ones.
 *
 * Extraction runs on a cheap/local model: it is a bulk pass over thousands of
 * items, and paying a frontier model to read a personal archive is exactly the
 * spend this system is built to avoid.
 */

const EXTRACT_PROMPT = `Extract DECISIONS from the text below. A decision is a conclusion the person reached — a choice made, an approach settled on, a position taken, a plan committed to.

Do NOT extract:
- questions, options being weighed, or things merely discussed
- general facts, definitions, or explanations
- anything the assistant suggested that the person did not adopt

For each decision give:
  "statement"  - the conclusion as a claim, in the person's own terms. Specific, standalone, under 200 chars.
  "rationale"  - why, in one sentence, or "" if not stated
  "topic"      - a short lowercase topic slug, e.g. "database", "college-apps", "server-hosting"
  "confidence" - one of: acted_on (they did it), decided (clearly settled), stated (asserted in passing), considered (leaning)

Return ONLY a JSON array. Empty array if there are no real decisions. Most text contains none — returning [] is the correct and common answer.

TEXT:
`;

interface Extracted {
  statement: string;
  rationale?: string;
  topic?: string;
  confidence?: string;
}

function parseArray(raw: string | null): Extracted[] {
  if (!raw) return [];
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((d): d is Extracted =>
        Boolean(d && typeof d === 'object' && typeof (d as Extracted).statement === 'string'))
      .filter((d) => d.statement.trim().length > 12)
      .slice(0, 8); // A single item yielding dozens of "decisions" is the model
                    // padding, not a genuinely dense source.
  } catch {
    return [];
  }
}

const VALID_CONFIDENCE = new Set(['acted_on', 'decided', 'stated', 'considered']);

export interface ExtractStats {
  scanned: number;
  found: number;
  skipped: number;
  errors: number;
}

/**
 * Runs extraction over un-processed knowledge items.
 *
 * Resumable by design: `decision_extractions` records what has been seen, so a
 * pass over thousands of items survives a restart rather than starting over.
 */
export async function extractDecisions(limit = 50): Promise<ExtractStats> {
  const stats: ExtractStats = { scanned: 0, found: 0, skipped: 0, errors: 0 };

  const items = await query<{
    id: string; title: string | null; content: string;
    source_created_at: Date | null; source_kind: string;
  }>(
    `SELECT i.id, i.title, i.content, i.source_created_at, s.kind AS source_kind
       FROM knowledge_items i
       JOIN knowledge_sources s ON s.id = i.source_id
       LEFT JOIN decision_extractions e ON e.item_id = i.id
      WHERE e.item_id IS NULL
        AND length(i.content) > 400
        -- Conversations are where decisions live. Vault notes and knowledge-base
        -- entries are mostly already-distilled facts.
        AND s.kind IN ('chatgpt_export', 'claude_export', 'obsidian')
      ORDER BY i.source_created_at DESC NULLS LAST
      LIMIT $1`,
    [limit],
  );

  for (const item of items) {
    stats.scanned += 1;
    try {
      // Long conversations are truncated rather than chunked: decisions cluster
      // where a thread concludes, and the tail is the highest-yield slice.
      const text = item.content.length > 12_000
        ? item.content.slice(-12_000)
        : item.content;

      const found = parseArray(await cheapComplete(EXTRACT_PROMPT + text, { maxChars: 16_000 }));

      for (const d of found) {
        const confidence = VALID_CONFIDENCE.has(d.confidence ?? '')
          ? d.confidence!
          : 'stated';

        const row = await one<{ id: string }>(
          `INSERT INTO decisions
             (statement, rationale, topic, confidence, decided_at,
              source_item_id, source_kind, source_excerpt)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id`,
          [
            d.statement.slice(0, 500),
            d.rationale?.slice(0, 800) ?? null,
            d.topic?.slice(0, 60)?.toLowerCase() ?? null,
            confidence,
            item.source_created_at,
            item.id,
            item.source_kind,
            item.title?.slice(0, 200) ?? null,
          ],
        );

        // Embedded immediately so recall works on decisions themselves rather
        // than on the conversations they came from.
        if (row) await embedDecision(row.id, d.statement, d.rationale ?? '');
        stats.found += 1;
      }

      if (found.length === 0) stats.skipped += 1;

      await query(
        `INSERT INTO decision_extractions (item_id, found, model)
         VALUES ($1,$2,'cheap') ON CONFLICT (item_id) DO NOTHING`,
        [item.id, found.length],
      );
    } catch (err) {
      stats.errors += 1;
      console.error('[decisions] extraction failed', item.id, err instanceof Error ? err.message : err);
    }
  }

  if (stats.found > 0) {
    await recordEvent({
      type: 'decisions.extracted',
      message: `${stats.found} decision(s) from ${stats.scanned} item(s)`,
      data: stats as unknown as Record<string, unknown>,
    });
    await linkSupersessions();
  }

  return stats;
}

async function embedDecision(id: string, statement: string, rationale: string): Promise<void> {
  try {
    const [vec] = await embed([`${statement}\n${rationale}`]);
    if (!vec) return;
    await query(
      `INSERT INTO embeddings (owner_kind, owner_id, model, dim, embedding)
       VALUES ('decision', $1, $2, $3, $4::vector)
       ON CONFLICT (owner_kind, owner_id, model) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [id, config.embedding.model, config.embedding.dim, toVectorLiteral(vec)],
    );
  } catch {
    // Recall degrades to text search; not worth failing the extraction over.
  }
}

/**
 * Marks older decisions on the same topic as superseded.
 *
 * Conservative on purpose — same topic, clearly earlier, and only when the
 * newer one is at least as firm. Aggressive supersession would quietly hide
 * positions that are still current, which is a worse failure than showing two
 * and letting the reader judge.
 */
async function linkSupersessions(): Promise<void> {
  await query(
    `UPDATE decisions old
        SET superseded_by = newer.id,
            superseded_at = newer.decided_at,
            status = 'superseded'
       FROM decisions newer
      WHERE old.topic IS NOT NULL
        AND old.topic = newer.topic
        AND old.id <> newer.id
        AND old.status = 'current'
        AND old.decided_at IS NOT NULL
        AND newer.decided_at IS NOT NULL
        AND newer.decided_at > old.decided_at + interval '14 days'
        AND CASE newer.confidence
              WHEN 'acted_on' THEN 4 WHEN 'decided' THEN 3
              WHEN 'stated' THEN 2 ELSE 1 END
          >= CASE old.confidence
              WHEN 'acted_on' THEN 4 WHEN 'decided' THEN 3
              WHEN 'stated' THEN 2 ELSE 1 END`,
  );
}

export interface DecisionAnswer {
  statement: string;
  rationale: string | null;
  topic: string | null;
  confidence: string;
  decided_at: Date | null;
  source_kind: string | null;
  relevance: number;
  superseded: boolean;
  replaced?: string[];
}

/**
 * Answers "what did I decide about X".
 *
 * Returns current positions first, each carrying what it replaced, so a
 * reversal is visible rather than silently hidden.
 */
export async function askDecisions(question: string, limit = 8): Promise<DecisionAnswer[]> {
  const hits = await recall(question, { limit: limit * 3, ownerKinds: ['decision'] });

  if (hits.length === 0) {
    // Falls back to literal matching when nothing is embedded yet, so the
    // feature is useful before a full extraction pass has run.
    const rows = await query<DecisionAnswer>(
      `SELECT statement, rationale, topic, confidence, decided_at, source_kind,
              0.5 AS relevance, (status <> 'current') AS superseded
         FROM decisions
        WHERE statement ILIKE '%' || $1 || '%' OR topic ILIKE '%' || $1 || '%'
        ORDER BY (status = 'current') DESC, decided_at DESC NULLS LAST
        LIMIT $2`,
      [question, limit],
    );
    return rows;
  }

  const ids = hits.map((h) => h.owner_id);
  const rank = new Map(hits.map((h) => [h.owner_id, 1 - h.distance]));

  const rows = await query<DecisionAnswer & { id: string }>(
    `SELECT d.id, d.statement, d.rationale, d.topic, d.confidence, d.decided_at,
            d.source_kind, (d.status <> 'current') AS superseded,
            coalesce(
              array_agg(p.statement) FILTER (WHERE p.id IS NOT NULL),
              '{}'
            ) AS replaced
       FROM decisions d
       LEFT JOIN decisions p ON p.superseded_by = d.id
      WHERE d.id = ANY($1::uuid[])
      GROUP BY d.id`,
    [ids],
  );

  // Ordering has to happen here, not in SQL: relevance lives in the vector
  // ranking, and ordering by date in the query meant the best match came back
  // last. Superseded positions still surface, but below current ones — a
  // reversal is worth seeing, just not worth leading with.
  const scored = rows.map((r) => ({
    ...r,
    relevance: Number((rank.get(r.id) ?? 0).toFixed(3)),
  }));

  // Weak matches are noise rather than answers. With a sparse decision store
  // every query otherwise returns something, which reads as confident and
  // wrong.
  const FLOOR = 0.45;
  const usable = scored.filter((r) => r.relevance >= FLOOR);
  const ranked = (usable.length > 0 ? usable : scored)
    .sort((a, b) => {
      if (a.superseded !== b.superseded) return a.superseded ? 1 : -1;
      return b.relevance - a.relevance;
    })
    .slice(0, limit);

  return ranked;
}
