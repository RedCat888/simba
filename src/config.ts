import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Runtime configuration. Secrets never live here and never reach Postgres —
 * brain credentials stay in per-account CLI config directories on disk, which
 * is also what makes multi-account isolation work.
 */

const home = homedir();

/**
 * The trusted listener's bind address, constrained to loopback.
 *
 * Refuses rather than silently corrects: a deployment that asked to listen
 * broadly and quietly got loopback would be confusing in a different way, and
 * this is a security boundary — it should fail loudly enough to be noticed.
 */
function gatewayHost(): string {
  const requested = process.env.SIMBA_GATEWAY_HOST;
  if (!requested) return '127.0.0.1';

  const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (loopback.has(requested.toLowerCase())) return requested;

  throw new Error(
    `SIMBA_GATEWAY_HOST=${requested} is refused. The local listener grants ` +
      `desktop authority without authentication, so binding it off-loopback ` +
      `would expose unauthenticated control of this machine to the network. ` +
      `Use the Cloudflare tunnel for remote access.`,
  );
}

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
    /** Local channel. Trusted. cloudflared must never point here. */
    port: Number(process.env.SIMBA_GATEWAY_PORT ?? 8787),
    /**
     * Tunnel channel. The only ingress cloudflared is configured for.
     *
     * The split exists because cloudflared runs on this host and dials
     * loopback, so a request's source address cannot distinguish local traffic
     * from tunnel traffic. The listening port can, and unlike any header it is
     * not settable by the client.
     */
    tunnelPort: Number(process.env.SIMBA_TUNNEL_PORT ?? 8788),
    /**
     * Loopback only, and not merely by default.
     *
     * The local channel grants desktop authority with no identity check at all —
     * that is the whole point of the port split, and it is safe precisely
     * because nothing off this machine can reach the port. SIMBA_GATEWAY_HOST
     * accepted any address, so a single environment variable
     * (`SIMBA_GATEWAY_HOST=0.0.0.0`) would have exposed unauthenticated desktop
     * authority to the entire LAN. Nothing else in the system would notice: the
     * requests would look local because they arrived on the local port.
     *
     * A latent hazard rather than a live hole — the listener is bound to
     * 127.0.0.1 today — but "one typo from catastrophic" is not a property worth
     * keeping when the fix is to refuse the value. Reaching Simba from
     * elsewhere is what the Cloudflare tunnel and Access are for.
     */
    host: gatewayHost(),
    token: process.env.SIMBA_GATEWAY_TOKEN ?? '',
  },

  access: {
    enabled: process.env.SIMBA_TUNNEL_ENABLED === '1',
    team: process.env.SIMBA_ACCESS_TEAM ?? '',
    aud: process.env.SIMBA_ACCESS_AUD ?? '',
    /** Human identities permitted through Access, checked at the origin too. */
    emails: (process.env.SIMBA_ACCESS_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    /** `<client-id>.access=<surface-slug>` pairs for non-interactive clients. */
    serviceTokens: Object.fromEntries(
      (process.env.SIMBA_ACCESS_SERVICE_TOKENS ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          const [cn, surface] = p.split('=');
          return [(cn ?? '').trim(), (surface ?? 'phone').trim()];
        }),
    ) as Record<string, string>,
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

  /**
   * ReelAgent — the Instagram intake, which is its own process.
   *
   * It listens on loopback and cannot reach the phone; the gateway can. So the
   * gateway proxies it, and the phone keeps needing exactly one credential
   * (Cloudflare Access) rather than learning about a second service.
   */
  reels: {
    url: process.env.SIMBA_REEL_URL ?? 'http://127.0.0.1:4877',
    token: process.env.SIMBA_REEL_TOKEN ?? '',
    /** Short: a busy or dead ReelAgent must render as "not running", not hang. */
    timeoutMs: 6000,
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

/**
 * Refuses to start misconfigured rather than starting insecure.
 *
 * The gateway fronts agents that hold a full shell on this machine. The failure
 * mode being prevented is the one the old `SIMBA_GATEWAY_TOKEN` default had: an
 * empty value silently disabling the check, so the system looks protected and
 * is not. If the tunnel is on, identity verification must be configured.
 */
if (config.access.enabled) {
  const missing: string[] = [];
  if (!config.access.team) missing.push('SIMBA_ACCESS_TEAM');
  if (!config.access.aud) missing.push('SIMBA_ACCESS_AUD');
  if (config.access.emails.length === 0 && Object.keys(config.access.serviceTokens).length === 0) {
    missing.push('SIMBA_ACCESS_EMAILS or SIMBA_ACCESS_SERVICE_TOKENS');
  }
  if (missing.length > 0) {
    throw new Error(
      `SIMBA_TUNNEL_ENABLED=1 but Access is not configured: missing ${missing.join(', ')}. ` +
        `Refusing to start — an exposed gateway with unverified identity would grant ` +
        `shell access to anyone who finds the hostname.`,
    );
  }
}
