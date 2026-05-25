import {
  deleteCredential,
  getCredential,
  setCredential,
} from './credentialStore.ts';
import { resolveProvider } from './discovery.ts';
import { getCachedClient } from './oauthClients.ts';
import { getProvider } from './providers.ts';

export class CannotRefreshError extends Error {
  readonly provider: string;
  readonly userId: string;
  constructor(provider: string, userId: string, detail: string) {
    super(
      `Cannot refresh credential for provider="${provider}" user="${userId}": ${detail}. ` +
        `Reconnect with:  npm run connect -- --provider ${provider} --user ${userId}`,
    );
    this.name = 'CannotRefreshError';
    this.provider = provider;
    this.userId = userId;
  }
}

export class RefreshFailedError extends Error {
  readonly provider: string;
  readonly userId: string;
  readonly statusCode?: number;
  readonly providerError?: string;
  constructor(
    provider: string,
    userId: string,
    detail: string,
    opts: { statusCode?: number; providerError?: string } = {},
  ) {
    super(
      `Refresh failed for provider="${provider}" user="${userId}": ${detail}. ` +
        `Reconnect with:  npm run connect -- --provider ${provider} --user ${userId}`,
    );
    this.name = 'RefreshFailedError';
    this.provider = provider;
    this.userId = userId;
    this.statusCode = opts.statusCode;
    this.providerError = opts.providerError;
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  [k: string]: unknown;
}

/**
 * Exchange a refresh token for a new access token. On success the credential
 * row is updated in-place (rotated refresh_token is preserved if returned,
 * otherwise the old one stays). On a 4xx response we treat the grant as
 * permanently revoked: the row is deleted and a RefreshFailedError is thrown
 * so the caller surfaces "please reconnect". On 5xx or network failure the
 * row is left intact (transient) and RefreshFailedError is thrown without
 * deletion.
 *
 * Returns the new access token string.
 */
export async function refreshOAuthToken(userId: string, provider: string): Promise<string> {
  const cred = await getCredential(userId, provider);
  if (!cred) throw new CannotRefreshError(provider, userId, 'no credential row');
  if (!cred.refreshToken) {
    throw new CannotRefreshError(provider, userId, 'no refresh token');
  }

  const baseProvider = getProvider(provider);
  if (!baseProvider) {
    throw new CannotRefreshError(provider, userId, `provider "${provider}" is not registered`);
  }
  const resolved = await resolveProvider(baseProvider);
  if (!resolved.tokenEndpoint) {
    throw new CannotRefreshError(provider, userId, 'provider has no token_endpoint after discovery');
  }

  const clientRecord = await getCachedClient(provider);
  if (!clientRecord) {
    throw new CannotRefreshError(
      provider,
      userId,
      'no cached OAuth client (was this ever connected?)',
    );
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', cred.refreshToken);
  body.set('client_id', clientRecord.clientId);
  if (clientRecord.clientSecret) body.set('client_secret', clientRecord.clientSecret);

  let res: Response;
  try {
    res = await fetch(resolved.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new RefreshFailedError(provider, userId, `network error: ${(err as Error).message}`);
  }

  if (res.status >= 400 && res.status < 500) {
    // Permanent failure — provider rejected our grant. Delete the row so the
    // user is forced to reconnect and we don't keep retrying with bad tokens.
    const text = await res.text().catch(() => '');
    await deleteCredential(userId, provider);
    throw new RefreshFailedError(provider, userId, `provider rejected refresh (${res.status})`, {
      statusCode: res.status,
      providerError: text,
    });
  }
  if (!res.ok) {
    // 5xx or other unexpected — transient. Don't delete; let the caller retry.
    const text = await res.text().catch(() => '');
    throw new RefreshFailedError(provider, userId, `provider error (${res.status})`, {
      statusCode: res.status,
      providerError: text,
    });
  }

  const tokens = (await res.json()) as TokenResponse;
  if (!tokens.access_token) {
    throw new RefreshFailedError(provider, userId, 'response missing access_token');
  }

  await setCredential(userId, provider, {
    kind: 'oauth',
    accessToken: tokens.access_token,
    // Notion (and most providers) rotate the refresh token. If the provider
    // returns a new one, save it; otherwise preserve the existing one.
    refreshToken: tokens.refresh_token ?? cred.refreshToken,
    expiresAt: tokens.expires_in
      ? Math.floor(Date.now() / 1000) + tokens.expires_in
      : cred.expiresAt,
    scope: tokens.scope ?? cred.scope,
    metadata: tokens.token_type ? { tokenType: tokens.token_type } : cred.metadata,
  });

  return tokens.access_token;
}
