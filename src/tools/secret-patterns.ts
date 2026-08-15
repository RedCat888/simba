/**
 * What a credential looks like.
 *
 * Split out of secrets-scan.ts, which is a CLI entrypoint: it calls main() at
 * module load and closes the database pool in a finally. Importing it for this
 * one constant therefore ran a full disk scan and shut the gateway's connection
 * pool — every route 500ed, not only the one that imported it. A module that
 * does something when you import it cannot be a library, and a list of regexes
 * has no business being reachable only through one.
 *
 * One list, shared. The scanner hunts with these; the file browser masks with
 * them. Two copies would drift, and the half that drifts is the half that leaks.
 */

export interface Pattern {
  name: string;
  re: RegExp;
  severity: 'critical' | 'high' | 'medium';
  /**
   * Mask only this capture group rather than the whole match.
   *
   * For `IG_BOT_PASSWORD=hunter2` the useful redaction keeps the name and hides
   * the value: you can still see what the file configures, which is most of why
   * you opened it, without the thing that matters being on screen.
   */
  maskGroup?: number;
}

export const PATTERNS: Pattern[] = [
  // Long-lived and directly abusable.
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/, severity: 'critical' },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, severity: 'critical' },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, severity: 'critical' },
  { name: 'Stripe secret key', re: /\bsk_live_[A-Za-z0-9]{16,}\b/, severity: 'critical' },
  { name: 'OpenAI key', re: /\bsk-[A-Za-z0-9_-]{32,}\b/, severity: 'critical' },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/, severity: 'critical' },
  { name: 'Discord bot token', re: /\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/, severity: 'critical' },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, severity: 'critical' },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: 'high' },

  // JWTs are worth flagging but are often short-lived or public-scoped, so they
  // sit below the keys above rather than alongside them.
  { name: 'JWT (possible service key)', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, severity: 'high' },

  // Assignment-shaped secrets: high recall, so kept at medium to avoid drowning
  // the real findings.
  { name: 'Hardcoded secret assignment', re: /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i, severity: 'medium' },

  /**
   * Env-file assignment, unquoted.
   *
   * The pattern above requires quotes, which is right for source code and
   * misses the entire syntax of a .env — `KEY=value`, bare. Found by pointing
   * the new file browser at ReelAgent/.env and getting the Instagram password,
   * the session id and the intake token back in the clear, masked count zero.
   * The scanner reads .env files too, so it had been blind to exactly this.
   *
   * Keyed on the *name* rather than the shape of the value, because a password
   * and a port number look identical and only the name says which is which.
   * That is why PORT, URL and USERNAME assignments are untouched: a masker that
   * fires on every line of a config file makes it unreadable, which is its own
   * way of hiding things.
   */
  {
    name: 'Secret in an env assignment',
    re: /^([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|SESSIONID|AUTH|PRIVATE)[A-Z0-9_]*\s*=\s*)(\S{8,})$/im,
    severity: 'high',
    maskGroup: 2,
  },
];
