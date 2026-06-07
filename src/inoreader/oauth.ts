import type { TokenRepo, StoredTokens } from '../db/repositories.js';

/**
 * Inoreader OAuth2 authorization-code flow.
 *
 * Endpoints (per https://www.inoreader.com/developers/oauth):
 *   authorize: https://www.inoreader.com/oauth2/auth
 *   token:     https://www.inoreader.com/oauth2/token
 */
export const INOREADER_AUTH_URL = 'https://www.inoreader.com/oauth2/auth';
export const INOREADER_TOKEN_URL = 'https://www.inoreader.com/oauth2/token';
export const INOREADER_SCOPE = 'read write';

export type FetchFn = typeof fetch;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function buildAuthorizeUrl(cfg: OAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: INOREADER_SCOPE,
    state,
  });
  return `${INOREADER_AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number; // seconds
  token_type: string;
}

function toStored(r: TokenResponse): StoredTokens {
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    // Refresh 60s early to avoid edge-of-expiry failures.
    expiresAt: Date.now() + (r.expires_in - 60) * 1000,
  };
}

export async function exchangeCode(
  cfg: OAuthConfig,
  code: string,
  fetchFn: FetchFn = fetch,
): Promise<StoredTokens> {
  const body = new URLSearchParams({
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'authorization_code',
  });
  const res = await fetchFn(INOREADER_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Inoreader token exchange failed: ${res.status} ${await res.text()}`);
  }
  return toStored((await res.json()) as TokenResponse);
}

export async function refreshTokens(
  cfg: OAuthConfig,
  refreshToken: string,
  fetchFn: FetchFn = fetch,
): Promise<StoredTokens> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetchFn(INOREADER_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Inoreader token refresh failed: ${res.status} ${await res.text()}`);
  }
  const stored = toStored((await res.json()) as TokenResponse);
  // Inoreader may omit a new refresh_token; keep the existing one.
  if (!stored.refreshToken) stored.refreshToken = refreshToken;
  return stored;
}

/**
 * Returns a valid access token, refreshing + persisting if expired.
 * Throws if no tokens are stored (user must connect Inoreader first).
 */
export async function getValidAccessToken(
  cfg: OAuthConfig,
  tokens: TokenRepo,
  fetchFn: FetchFn = fetch,
  now: number = Date.now(),
): Promise<string> {
  const stored = tokens.load('inoreader');
  if (!stored) throw new Error('Inoreader is not connected. Authorize the app first.');
  if (stored.expiresAt > now) return stored.accessToken;
  if (!stored.refreshToken) throw new Error('Access token expired and no refresh token available.');
  const refreshed = await refreshTokens(cfg, stored.refreshToken, fetchFn);
  tokens.save('inoreader', refreshed);
  return refreshed.accessToken;
}
