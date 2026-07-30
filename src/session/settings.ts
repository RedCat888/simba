import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from '../config.js';
import { getPermissionProfile } from '../db/repo.js';

/**
 * Materializes the per-session settings file that wires the deny-list guard in
 * as a PreToolUse hook.
 *
 * This file is a build artifact: regenerated for every session, never read back
 * afterwards, never hand-edited. The permission profile row is the truth.
 */

const SETTINGS_DIR = join(config.root, 'var', 'sessions');
const GUARD = join(config.root, 'scripts', 'guard.mjs');

export async function writeSessionSettings(
  sessionId: string,
  permissionProfileId: string | null,
): Promise<string | null> {
  const profile = await getPermissionProfile(permissionProfileId);
  if (!profile || profile.deny_patterns.length === 0) return null;

  await mkdir(SETTINGS_DIR, { recursive: true });

  const patternsPath = join(SETTINGS_DIR, `${sessionId}.patterns.json`);
  await writeFile(
    patternsPath,
    JSON.stringify({ deny: profile.deny_patterns, confirm: profile.confirm_patterns }, null, 2),
    'utf8',
  );

  const settings = {
    hooks: {
      PreToolUse: [
        {
          // Only the tools that can actually reach the operations on the deny
          // list. Guarding every tool would tax reads and greps for nothing.
          matcher: 'Bash|PowerShell|Write|Edit',
          hooks: [
            {
              type: 'command',
              command: `node "${GUARD}" "${patternsPath}"`,
              timeout: 10,
            },
          ],
        },
      ],
    },
  };

  const settingsPath = join(SETTINGS_DIR, `${sessionId}.settings.json`);
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return settingsPath;
}
