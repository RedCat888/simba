import { recordEvent } from '../db/index.js';
import { config } from '../config.js';
import {
  AccessDenied,
  describePrincipal,
  surfaceForPrincipal,
  verifyAccessJwt,
  type Principal,
} from './access.js';
import { getSurface, type Surface } from './surface.js';

/**
 * One authentication decision, shared by HTTP and the WebSocket upgrade.
 *
 * The channel a request arrived on — which local port it landed on — is the
 * root of the decision, because it is the only signal a client cannot set.
 * Headers are then used only to *prove identity within* a channel, never to
 * establish which channel something came from.
 */

export type Channel = 'local' | 'tunnel';

export interface AuthOk {
  ok: true;
  channel: Channel;
  surface: Surface;
  principal: Principal | null;
}

export interface AuthFail {
  ok: false;
  status: 401 | 403 | 404;
  reason: string;
}

export type AuthResult = AuthOk | AuthFail;

/** Headers the Cloudflare edge stamps. Their presence on the local channel means a mis-pointed tunnel. */
const CF_HEADERS = [
  'cf-ray',
  'cf-connecting-ip',
  'cf-warp-tag-id',
  'cf-access-jwt-assertion',
  'cf-access-authenticated-user-email',
];

export function channelOf(localPort: number | undefined): Channel {
  return localPort === config.gateway.tunnelPort ? 'tunnel' : 'local';
}

function hasCloudflareHeaders(h: Record<string, string | undefined>): boolean {
  return CF_HEADERS.some((k) => Boolean(h[k]));
}

/**
 * Host allow-list — the DNS-rebinding defence.
 *
 * Without it, a page on any site can resolve its own hostname to 127.0.0.1 and
 * talk to the local channel from inside the browser, inheriting desktop trust.
 */
export function hostAllowed(channel: Channel, host: string | undefined): boolean {
  if (channel === 'tunnel') return true; // Cloudflare fixes the Host upstream.
  if (!host) return false;
  const allowed = [
    `127.0.0.1:${config.gateway.port}`,
    `localhost:${config.gateway.port}`,
  ];
  return allowed.includes(host.toLowerCase());
}

/**
 * Origin allow-list. An absent Origin is fine for native clients and curl; a
 * present one must match, which is what stops a random page from driving the
 * local API with the browser's ambient authority.
 */
export function originAllowed(channel: Channel, origin: string | undefined): boolean {
  if (!origin) return true;
  if (channel === 'tunnel') return true;
  const allowed = [
    `http://127.0.0.1:${config.gateway.port}`,
    `http://localhost:${config.gateway.port}`,
  ];
  return allowed.includes(origin.toLowerCase());
}

async function deny(status: 401 | 403, reason: string, severity: 'warn' | 'critical' = 'warn'): Promise<AuthFail> {
  await recordEvent({ type: 'auth.denied', severity, message: reason });
  return { ok: false, status, reason };
}

export async function authenticate(
  channel: Channel,
  headers: Record<string, string | undefined>,
): Promise<AuthResult> {
  if (channel === 'local') {
    // Cloudflare headers arriving on the local listener mean cloudflared is
    // pointed at the wrong port. Failing loudly here is what stops that
    // misconfiguration from silently granting every remote request desktop
    // authority — the exact hole the port split exists to close.
    if (hasCloudflareHeaders(headers)) {
      await recordEvent({
        type: 'auth.misconfig',
        severity: 'critical',
        message:
          `Cloudflare headers arrived on the local channel (port ${config.gateway.port}). ` +
          `cloudflared is likely pointed at the wrong port — it must target ` +
          `${config.gateway.tunnelPort}. Refusing the request.`,
      });
      return { ok: false, status: 403, reason: 'cloudflare headers on local channel' };
    }

    const surface = await getSurface('desktop');
    if (!surface) return deny(403, 'desktop surface missing');
    return { ok: true, channel, surface, principal: null };
  }

  // Tunnel channel: identity must be proven, never assumed.
  let principal: Principal;
  try {
    principal = await verifyAccessJwt(headers['cf-access-jwt-assertion']);
  } catch (err) {
    if (err instanceof AccessDenied) {
      return deny(
        err.status,
        `tunnel request rejected: ${err.reason}`,
        err.status === 403 ? 'critical' : 'warn',
      );
    }
    return deny(401, 'tunnel request rejected: verification error');
  }

  const slug = surfaceForPrincipal(principal);
  const surface = await getSurface(slug);
  if (!surface) return deny(403, `surface "${slug}" is not defined`);
  if (!surface.enabled) return deny(403, `surface "${slug}" is disabled`, 'warn');

  return { ok: true, channel, surface, principal };
}

export { describePrincipal };
