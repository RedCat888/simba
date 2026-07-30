import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Runtime configuration. Secrets never live here and never reach Postgres —
 * brain credentials stay in per-account CLI config directories on disk, which
 * is also what makes multi-account isolation work.
 */

const home = homedir();

export const config = {
  root: join(home, 'simba'),

  db: {
    host: process.env.SIMBA_PG_HOST ?? 'localhost',
    port: Number(process.env.SIMBA_PG_PORT ?? 5432),
    database: process.env.SIMBA_PG_DATABASE ?? 'simba',
    user: process.env.SIMBA_PG_USER ?? 'postgres',
    password: process.env.SIMBA_PG_PASSWORD ?? '',
    max: 12,
  },

  paths: {
    postgresBin: join(home, 'scoop', 'apps', 'postgresql', 'current', 'bin'),
    worktrees: join(home, 'simba', 'var', 'worktrees'),
    logs: join(home, 'simba', 'var', 'logs'),
    brains: join(home, '.simba-brains'),
  },

  gateway: {
    port: Number(process.env.SIMBA_GATEWAY_PORT ?? 8787),
    host: process.env.SIMBA_GATEWAY_HOST ?? '127.0.0.1',
    token: process.env.SIMBA_GATEWAY_TOKEN ?? '',
  },

  /**
   * Local embedding model, served by Ollama. Chosen so the vector store needs
   * no API key and no per-token spend, consistent with the rest of the
   * subscription-only posture. Dimension is pinned in migration 005.
   */
  embedding: {
    endpoint: process.env.SIMBA_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    model: process.env.SIMBA_EMBED_MODEL ?? 'nomic-embed-text',
    dim: 768,
    batchSize: 32,
  },

  supervisor: {
    /** How often to sweep for stalled sessions and due wake-ups. */
    tickMs: 15_000,
    /** A running session with no activity for this long is considered stalled. */
    stallMs: 10 * 60_000,
    /** Checkpoints are written every turn; this is the ceiling between them. */
    checkpointIntervalMs: 5 * 60_000,
  },
} as const;

export type Config = typeof config;
