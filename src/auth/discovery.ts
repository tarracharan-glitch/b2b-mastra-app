import type { OAuthProvider } from './providers.ts';

interface DiscoveryDoc {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  [k: string]: unknown;
}

const cache = new Map<string, OAuthProvider>();

/**
 * Merge a discovery document (when present) into the provider config.
 * Cached per-process so we don't re-fetch on every /connect.
 */
export async function resolveProvider(provider: OAuthProvider): Promise<OAuthProvider> {
  const cached = cache.get(provider.name);
  if (cached) return cached;

  if (!provider.discoveryUrl) {
    cache.set(provider.name, provider);
    return provider;
  }

  const res = await fetch(provider.discoveryUrl, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`discovery fetch failed (${res.status}) for ${provider.name}`);
  }
  const doc = (await res.json()) as DiscoveryDoc;

  const resolved: OAuthProvider = {
    ...provider,
    // Provider config wins if explicitly set; otherwise fall back to discovery.
    authorizationEndpoint: provider.authorizationEndpoint ?? doc.authorization_endpoint,
    tokenEndpoint: provider.tokenEndpoint ?? doc.token_endpoint,
    registrationEndpoint: provider.registrationEndpoint ?? doc.registration_endpoint,
    revocationEndpoint: provider.revocationEndpoint ?? doc.revocation_endpoint,
  };
  cache.set(provider.name, resolved);
  return resolved;
}

/** Test-only: clear the discovery cache. */
export function __resetDiscoveryCacheForTests(): void {
  cache.clear();
}
