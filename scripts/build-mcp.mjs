/**
 * Bundles the MCP server to a single plain-JS file.
 *
 * Agent CLIs spawn this server themselves, from whatever working directory the
 * session happens to be in. Anything that needs module resolution at launch —
 * `npx`, a `tsx` loader, a bare package specifier — resolves relative to that
 * directory and fails, and the only symptom the agent sees is that its tools do
 * not exist. Bundling removes the entire class: one file, plain node, no
 * resolution, no loader, and a much faster cold start.
 *
 *   node scripts/build-mcp.mjs
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [join(root, 'src', 'mcp', 'server.ts')],
  outfile: join(root, 'dist', 'mcp-server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // pg ships optional native bits and dynamic requires that do not survive
  // bundling; leaving it external keeps it resolvable from the project's own
  // node_modules, which is where the server file lives.
  external: ['pg', 'pg-native'],
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      'const require = __cr(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});

console.log('built dist/mcp-server.mjs');
