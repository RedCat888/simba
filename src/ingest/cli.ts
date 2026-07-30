import { ingestSource } from './index.js';
import {
  readObsidian,
  readKnowledgeApi,
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

  const doKnowledgeApi = async () => {
    const base = (await sourceUri('knowledge-api')) ?? '';
    const token = process.env.SIMBA_KNOWLEDGE_TOKEN ?? '';
    if (!token) {
      console.log('knowledge-api: skipped (set SIMBA_KNOWLEDGE_TOKEN)');
      return;
    }
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
