import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from '../config.js';

/**
 * Generates the per-session MCP config that exposes Simba's database tools to
 * the agent running inside that session.
 *
 * This is what makes the no-markdown rule real rather than aspirational. An
 * agent writes notes to files because that is the tool it has; give it a
 * database it can reach as easily, and tell it which one is authoritative, and
 * the behaviour follows. Without this every later milestone gets rewritten.
 *
 * Identity is injected through the environment rather than inferred, so the
 * server always knows which agent and session it is acting for.
 */

const MCP_DIR = join(config.root, 'var', 'sessions');
const SERVER = join(config.root, 'src', 'mcp', 'server.ts');

export async function mcpConfigPathFor(sessionId: string, agentId: string): Promise<string> {
  await mkdir(MCP_DIR, { recursive: true });

  const cfg = {
    mcpServers: {
      simba: {
        command: 'npx',
        args: ['-y', 'tsx', SERVER],
        env: {
          SIMBA_AGENT_ID: agentId,
          SIMBA_SESSION_ID: sessionId,
          SIMBA_PG_HOST: config.db.host,
          SIMBA_PG_PORT: String(config.db.port),
          SIMBA_PG_DATABASE: config.db.database,
          SIMBA_PG_USER: config.db.user,
        },
      },
    },
  };

  const path = join(MCP_DIR, `${sessionId}.mcp.json`);
  await writeFile(path, JSON.stringify(cfg, null, 2), 'utf8');
  return path;
}
