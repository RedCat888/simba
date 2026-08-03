import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import { config } from '../config.js';

/**
 * Cloudflare Access JWT verification.
 *
 * The previous logic treated the *presence* of a `cf-*` header as proof a
 * request came through Cloudflare. Any process able to reach the port could set
 * that header, so it proved nothing. This module replaces presence with a
 * signature check against Cloudflare's published keys, which is the only thing
 * that actually establishes where a request came from.
 *
 * Deliberately does not read `Cf-Access-Authenticated-User-Email`. Access sets
 * it as a convenience, but it is unsigned and forgeable by anything that can
 * talk to the origin — trusting it would reintroduce exactly the hole this
 * exists to close.
 */

export type Principal =
  | { kind: 'user'; email: string; sub: string }
  | { kind: 'service'; commonName: string };

export class AccessDenied extends Error {
  constructor(
    readonly reason: string,
    readonly status: 401 | 403 = 401,
  ) {
    super(reason);
    this.name = 'AccessDenied';
  }
}

const issuer = config.access.team
  ? `https://${config.access.team}.cloudflareaccess.com`
  : '';

/**
 * Built once at module scope. The resolver handles key rotation itself: an
 * unrecognised `kid` triggers a refetch, rate-limited by `cooldownDuration` so
 * a flood of junk key ids cannot be turned into an outbound request amplifier.
 */
const jwks = issuer
  ? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      cacheMaxAge: 6 * 60 * 60_000,
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    })
  : null;

interface AccessClaims extends JWTPayload {
  email?: string;
  common_name?: string;
  type?: string;
}

export async function verifyAccessJwt(token: string | undefined): Promise<Principal> {
  if (!token) throw new AccessDenied('no Access assertion present', 401);
  if (!jwks || !issuer || !config.access.aud) {
    // Fails closed. A misconfigured origin must refuse rather than wave traffic
    // through, since the whole point is that this is the only gate.
    throw new AccessDenied('Access verification is not configured', 401);
  }

  let payload: AccessClaims;
  try {
    ({ payload } = await jwtVerify<AccessClaims>(token, jwks, {
      algorithms: ['RS256'],
      issuer,
      // The critical claim. Without pinning the audience, a token minted for
      // ANY other Access application in the same team would authenticate here.
      audience: config.access.aud,
      clockTolerance: 30,
      requiredClaims: ['exp', 'iat', 'aud', 'iss'],
    }));
  } catch (err) {
    throw new AccessDenied(
      `invalid Access assertion: ${err instanceof Error ? err.message : 'verification failed'}`,
      401,
    );
  }

  // A service-token JWT carries `common_name` and an empty `sub`; a human token
  // carries `email` and a real `sub`. Anything with neither is not a shape
  // Access produces, so it is refused rather than guessed at.
  if (payload.common_name) {
    const surface = config.access.serviceTokens[payload.common_name];
    if (!surface) {
      throw new AccessDenied(
        `service token "${payload.common_name}" is not allow-listed at the origin`,
        403,
      );
    }
    return { kind: 'service', commonName: payload.common_name };
  }

  if (payload.email && payload.sub) {
    const email = payload.email.trim().toLowerCase();
    if (!config.access.emails.includes(email)) {
      // Reaching here means the Access policy admitted an identity the origin
      // does not recognise — worth knowing about loudly, not silently allowing.
      throw new AccessDenied(`identity "${email}" is not allow-listed at the origin`, 403);
    }
    return { kind: 'user', email, sub: payload.sub };
  }

  throw new AccessDenied('Access assertion has neither an email nor a service identity', 403);
}

/** Surface slug an authenticated principal maps to. */
export function surfaceForPrincipal(p: Principal): string {
  return p.kind === 'service'
    ? (config.access.serviceTokens[p.commonName] ?? 'phone')
    : 'phone';
}

export function describePrincipal(p: Principal): string {
  return p.kind === 'service' ? `service:${p.commonName}` : `user:${p.email}`;
}

/**
 * Warms the JWKS cache so the first real request does not absorb a cold fetch.
 * Never throws: a control-plane blip at boot should delay, not prevent, start-up.
 */
export async function prewarmAccess(): Promise<void> {
  if (!jwks) return;
  try {
    await verifyAccessJwt('not.a.token');
  } catch {
    /* expected — the point is the key fetch, not the result */
  }
}
