import { cacheClient, getCachedClient, type OAuthClientRecord } from './oauthClients.ts';
import type { OAuthProvider } from './providers.ts';

/** RFC 7591 Dynamic Client Registration request body. */
export interface RegistrationRequest {
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_basic' | 'client_secret_post';
  grant_types: string[];
  response_types: string[];
  scope?: string;
}

/**
 * Return the cached client registration for `provider`, registering one
 * via DCR if the cache is empty and the provider supports it.
 *
 * For providers without DCR support, caller is expected to pre-cache a
 * client via cacheClient() (e.g. after manually creating an OAuth app).
 */
export async function ensureRegisteredClient(
  provider: OAuthProvider,
  redirectUri: string,
): Promise<OAuthClientRecord> {
  const cached = await getCachedClient(provider.name);
  if (cached) return cached;

  if (!provider.usesDcr) {
    throw new Error(
      `provider "${provider.name}" doesn't support DCR and has no cached client; ` +
        `register one manually via cacheClient()`,
    );
  }
  if (!provider.registrationEndpoint) {
    throw new Error(
      `provider "${provider.name}" has usesDcr=true but no registrationEndpoint after discovery`,
    );
  }

  const body: RegistrationRequest = {
    client_name: 'my-mastra-app',
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: provider.scopes.length ? provider.scopes.join(' ') : undefined,
  };

  const res = await fetch(provider.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DCR failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as {
    client_id: string;
    client_secret?: string;
    [k: string]: unknown;
  };
  await cacheClient(provider.name, {
    clientId: json.client_id,
    clientSecret: json.client_secret,
    metadata: json,
  });
  return {
    clientId: json.client_id,
    clientSecret: json.client_secret,
    metadata: json,
    createdAt: Math.floor(Date.now() / 1000),
  };
}
