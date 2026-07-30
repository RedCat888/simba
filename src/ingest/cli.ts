import { ingestSource } from './index.js';
import {
  readObsidian,
  readKnowledgeApi,
  readSupabaseKnowledge,
  readChatGptExport,
  readClaudeExport,
} from './sources.js';
import { closePool, one } from '../db/index.js';

/**
 * Ingest CLI.
 *
 *   npm run ingest -- obsidian
 *   npm run ingest -- knowledge-api
 *   npm run ingest -- chatgpt-export <path-to-export>
 *   npm run ingest -- claude-export  <path-to-export>
 *   npm run ingest -- all
 */

const [, , command, pathArg] = process.argv;

async function sourceUri(slug: string): Promise<string | null> {
  const row = await one<{ uri: string | null }>(
    `SELECT uri FROM knowledge_sources WHERE slug = $1`,
    [slug],
  );
  return row?.uri ?? null;
}

async function run(): Promise<void> {
  const report = (label: string, s: Awaited<ReturnType<typeof ingestSource>>) =>
    console.log(
      `${label}: ${s.seen} seen, ${s.inserted} new, ${s.updated} updated, ` +
        `${s.skipped} unchanged, ${s.chunks} chunks, ${s.embedded} embedded, ${s.errors} errors`,
    );

  const doObsidian = async () => {
    const vault = (await sourceUri('obsidian')) ?? '';
    report('obsidian', await ingestSource('obsidian', readObsidian(vault)));
  };

  /**
   * Prefers a direct Supabase read. The Worker in front of this corpus returns
   * empty results for every read (it does not check response status on read
   * paths), so going through it silently ingests nothing.
   */
  const doKnowledgeApi = async () => {
    const supabaseUrl = process.env.SIMBA_SUPABASE_URL ?? 'https://dckujuxrfngxoxqkpaux.supabase.co';
    const serviceKey = process.env.SIMBA_SUPABASE_KEY ?? '';

    if (serviceKey) {
      report(
        'knowledge (direct)',
        await ingestSource('knowledge-api', readSupabaseKnowledge(supabaseUrl, serviceKey)),
      );
      return;
    }

    const token = process.env.SIMBA_KNOWLEDGE_TOKEN ?? '';
    if (!token) {
      console.log('knowledge: skipped (set SIMBA_SUPABASE_KEY for a direct read)');
      return;
    }
    console.log(
      'knowledge: falling back to the Worker API, which currently returns empty ' +
        'results for all reads. Set SIMBA_SUPABASE_KEY to bypass it.',
    );
    const base = (await sourceUri('knowledge-api')) ?? '';
    report('knowledge-api', await ingestSource('knowledge-api', readKnowledgeApi(base, token)));
  };

  switch (command) {
    case 'obsidian':
      await doObsidian();
      break;
    case 'knowledge-api':
      await doKnowledgeApi();
      break;
    case 'chatgpt-export': {
      if (!pathArg) throw new Error('usage: ingest chatgpt-export <path>');
      report('chatgpt', await ingestSource('chatgpt-export', readChatGptExport(pathArg)));
      break;
    }
    case 'claude-export': {
      if (!pathArg) throw new Error('usage: ingest claude-export <path>');
      report('claude', await ingestSource('claude-export', readClaudeExport(pathArg)));
      break;
    }
    case 'all':
      await doObsidian();
      await doKnowledgeApi();
      break;
    default:
      console.log('usage: ingest <obsidian|knowledge-api|chatgpt-export|claude-export|all> [path]');
  }
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
