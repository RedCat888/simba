/**
 * OAuth access tokens that outlive the hour.
 *
 * The Google and Microsoft intakes read a raw *_ACCESS_TOKEN from the
 * environment. Those expire in about sixty minutes, so setting one connects
 * the source for one hour and then it 401s forever - which reads as "the
 * integration is broken" rather than "the token you pasted has expired", and
 * is the difference between a demo and something that runs.
 *
 * A refresh token does not expire on the same clock. Given a client id, secret
 * and refresh token, this exchanges for a short-lived access token and holds it
 * until shortly before it lapses.
 *
 * Nothing here reads or writes a credential anywhere but process.env. No token
 * is logged, and failures report the provider's status code and message rather
 * than anything that came out of the environment.
 */

type Cached = { token: string; expiresAt: number };
const cache = new Map<string, Cached>();

/** Refreshed a minute early, so a token never expires mid-request. */
const SKEW_MS = 60_000;

export type TokenResult =
  | { ok: true; token: string; source: 'static' | 'refreshed' }
  | { ok: false; reason: string };

async function exchange(
  provider: string,
  endpoint: string,
  body: Record<string, string>,
): Promise<TokenResult> {
  const hit = cache.get(provider);
  if (hit && hit.expiresAt > Date.now()) {
    return { ok: true, token: hit.token, source: 'refreshed' };
  }

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...body, grant_type: 'refresh_token' }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, reason: `${provider} token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }

  const text = await res.text();
  if (!res.ok) {
    // The body carries the actionable part - invalid_grant means the refresh
    // token was revoked and has to be reissued, which no retry will fix.
    return { ok: false, reason: `${provider} refresh failed (${res.status}): ${text.slice(0, 200)}` };
  }

  let parsed: { access_token?: string; expires_in?: number };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { ok: false, reason: `${provider} returned a non-JSON token response` };
  }
  if (!parsed.access_token) {
    return { ok: false, reason: `${provider} response contained no access_token` };
  }

  const ttlMs = (parsed.expires_in ?? 3600) * 1000;
  cache.set(provider, { token: parsed.access_token, expiresAt: Date.now() + ttlMs - SKEW_MS });
  return { ok: true, token: parsed.access_token, source: 'refreshed' };
}

/**
 * Gmail and Calendar.
 *
 * A raw GOOGLE_ACCESS_TOKEN still works and still takes precedence, because it
 * is how you check a scope is right in thirty seconds from the OAuth
 * playground. It is just not a way to run.
 */
export async function googleAccessToken(): Promise<TokenResult> {
  const staticToken = process.env.GOOGLE_ACCESS_TOKEN ?? process.env.GMAIL_ACCESS_TOKEN;
  if (staticToken) return { ok: true, token: staticToken, source: 'static' };

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    return {
      ok: false,
      reason: 'not configured: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN ' +
              '(or GOOGLE_ACCESS_TOKEN for a one-hour test)',
    };
  }
  return exchange('google', 'https://oauth2.googleapis.com/token', {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
}

/**
 * Outlook and Teams, through Microsoft Graph.
 *
 * Tenant defaults to `consumers` for a personal Microsoft account, which is
 * what sample-account is; a work or school account needs its tenant id instead.
 * The secret is optional because a public client registration does not have
 * one, and sending an empty string is not the same as omitting it.
 */
export async function microsoftAccessToken(): Promise<TokenResult> {
  const staticToken = process.env.MICROSOFT_ACCESS_TOKEN ?? process.env.MS_GRAPH_TOKEN;
  if (staticToken) return { ok: true, token: staticToken, source: 'static' };

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const refreshToken = process.env.MICROSOFT_REFRESH_TOKEN;
  if (!clientId || !refreshToken) {
    return {
      ok: false,
      reason: 'not configured: set MICROSOFT_CLIENT_ID and MICROSOFT_REFRESH_TOKEN ' +
              '(plus MICROSOFT_CLIENT_SECRET if the app registration is confidential, ' +
              'or MICROSOFT_ACCESS_TOKEN for a one-hour test)',
    };
  }
  const tenant = process.env.MICROSOFT_TENANT ?? 'consumers';
  const body: Record<string, string> = {
    client_id: clientId,
    refresh_token: refreshToken,
    scope: process.env.MICROSOFT_SCOPE ?? 'https://graph.microsoft.com/.default offline_access',
  };
  const secret = process.env.MICROSOFT_CLIENT_SECRET;
  if (secret) body.client_secret = secret;

  return exchange('microsoft', `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, body);
}

/** Drops cached tokens. Exposed for tests and for a forced re-auth. */
export function clearTokenCache(): void {
  cache.clear();
}
