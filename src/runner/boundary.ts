/**
 * The destructive-command boundary, stated to models that cannot be constrained.
 *
 * Three of the five runners enforce nothing. Claude applies the profile through
 * a PreToolUse hook and Ollama checks the regexes inside its own loop, but Codex
 * runs with --dangerously-bypass-approvals-and-sandbox, Cursor with --force, and
 * OpenCode does not consult its own permission config in non-interactive mode —
 * measured, not assumed. So on those three, failing over from Claude silently
 * removed the only hard boundary in the system.
 *
 * This is a soft control and is described as one: it depends on the model
 * choosing to comply. Verified to work on OpenCode's free model — asked to write
 * to HKLM it made zero tool calls, refused while quoting the rule back, and the
 * registry was unchanged. That is not the same as enforcement, and anything
 * genuinely dangerous should not rely on it alone.
 */
/**
 * The boundary text itself, since it cannot be imposed on the process.
 *
 * A soft control and described as one: it depends on the model choosing to
 * comply, which a capable model usually does and a confused one may not. It is
 * here because the alternative on this runner is nothing at all, and an
 * instruction the agent can read is strictly better than a config it ignores.
 */
export function denyNotice(patterns: string[]): string {
  if (patterns.length === 0) return '';
  return (
    `

<hard-boundary>
` +
    `Never run commands that repartition, format or wipe disks; alter boot ` +
    `configuration; delete shadow copies or backups; delete Windows services; ` +
    `write to machine-wide registry hives (HKLM, HKCR, HKU); delete anything ` +
    `under C:\Windows; or recursively delete a filesystem root.

` +
    `Specifically forbidden: diskpart, format, fsutil, mountvol, bcdedit, ` +
    `bcdboot, bootrec, bootsect, vssadmin delete, wbadmin delete, sc delete, ` +
    `Clear-Disk, Initialize-Disk, Remove-Partition, Format-Volume, ` +
    `reg delete/add on HKLM, and rm -rf /.

` +
    `Reading any of these is fine — reg query, fsutil behavior query and the ` +
    `like. It is modification that is refused. If a task appears to require ` +
    `one of these, stop and report why instead of finding a way around it.
` +
    `</hard-boundary>`
  );
}

