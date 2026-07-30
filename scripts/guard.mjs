#!/usr/bin/env node
/**
 * PreToolUse guard.
 *
 * Sessions run with bypassPermissions, so the CLI never asks before running a
 * command. That is deliberate — approval prompts were the thing this system
 * exists to remove. The deny list is therefore the entire safety surface, and
 * it has to be enforced somewhere the model cannot talk its way past. A hook is
 * that place: it sees the concrete tool input after the model has committed to
 * it, and its decision is final.
 *
 * Scope is exactly what was approved: core disk, OS, boot and registry
 * operations — the failures that leave a machine unbootable and that no retry
 * recovers from. Everything else runs unchallenged.
 *
 * Deliberately dependency-free and plain .mjs: this runs before every tool call,
 * so process start-up cost is a real tax and a TypeScript loader is not worth it.
 */

import { readFileSync } from 'node:fs';

const patternsPath = process.argv[2];

let patterns = [];
try {
  patterns = JSON.parse(readFileSync(patternsPath, 'utf8')).deny ?? [];
} catch {
  // A missing or malformed pattern file must fail closed on nothing: an empty
  // deny list is the documented default posture, not an error state.
  patterns = [];
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const toolInput = payload?.tool_input ?? {};
  // Concatenate the fields that can carry an executable command across the
  // tools that have one. Matching the whole blob avoids having to keep a
  // per-tool schema map in sync with the CLI.
  const haystack = [
    toolInput.command,
    toolInput.script,
    toolInput.file_path,
    toolInput.path,
    typeof toolInput === 'string' ? toolInput : '',
  ]
    .filter((v) => typeof v === 'string' && v)
    .join('\n');

  if (!haystack) process.exit(0);

  for (const p of patterns) {
    let re;
    try {
      re = new RegExp(p);
    } catch {
      continue;
    }
    if (re.test(haystack)) {
      const decision = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'Blocked by Simba: this touches core disk, OS, boot or registry state. ' +
            'These operations require the operator to run them himself. Do not attempt a ' +
            'workaround — report the block and move on to the rest of the task.',
        },
      };
      process.stdout.write(JSON.stringify(decision));
      process.exit(0);
    }
  }

  process.exit(0);
});
