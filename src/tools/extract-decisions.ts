import { extractDecisions } from '../knowledge/decisions.js';
import { query, closePool } from '../db/index.js';

/**
 * Bulk decision extraction.
 *
 *   npm run decisions -- [batches] [perBatch]
 *
 * Batched and resumable: the corpus is thousands of items and a local model
 * takes seconds each, so this is a long unattended job by nature. Progress is
 * recorded per item, so killing it mid-run costs at most one item's work.
 */

const batches = Number(process.argv[2] ?? 10);
const perBatch = Number(process.argv[3] ?? 25);

async function main(): Promise<void> {
  const [before] = await query<{ eligible: number; scanned: number }>(
    `SELECT
       (SELECT count(*)::int FROM knowledge_items i
          JOIN knowledge_sources s ON s.id = i.source_id
         WHERE s.kind IN ('chatgpt_export','claude_export','obsidian')
           AND length(i.content) > 400)          AS eligible,
       (SELECT count(*)::int FROM decision_extractions) AS scanned`,
  );
  console.log(`${before?.scanned ?? 0}/${before?.eligible ?? 0} items already scanned`);

  let totalFound = 0;
  for (let i = 1; i <= batches; i++) {
    const s = await extractDecisions(perBatch);
    totalFound += s.found;
    console.log(
      `batch ${i}/${batches}: scanned ${s.scanned}, found ${s.found}, ` +
        `none-in ${s.skipped}, errors ${s.errors}`,
    );
    if (s.scanned === 0) {
      console.log('nothing left to scan');
      break;
    }
  }

  const [after] = await query<{ total: number; current: number; superseded: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status='current')::int AS current,
            count(*) FILTER (WHERE status='superseded')::int AS superseded
       FROM decisions`,
  );
  console.log(
    `\n${totalFound} new this run · ${after?.total ?? 0} total ` +
      `(${after?.current ?? 0} current, ${after?.superseded ?? 0} superseded)`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
