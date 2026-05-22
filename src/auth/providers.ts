export interface OAuthProvider {
  /** Stable identifier used in URLs and DB rows (e.g. 'notion'). */
  name: string;
  /** RFC 8414 discovery URL — `.well-known/oauth-authorization-server`. */
  discoveryUrl?: string;
  /** Optional fallback if no discoveryUrl is set or discovery is partial. */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  /** Used in Phase 5 (disconnect/revoke). */
  revocationEndpoint?: string;
  /** OAuth scopes to request. Empty array = let the provider decide. */
  scopes: string[];
  /** MCP OAuth assumes PKCE. */
  usesPkce: true;
  /** Whether RFC 7591 Dynamic Client Registration is used. */
  usesDcr: boolean;
}

const registry = new Map<string, OAuthProvider>();

export function registerProvider(provider: OAuthProvider): void {
  registry.set(provider.name, provider);
}

export function getProvider(name: string): OAuthProvider | undefined {
  return registry.get(name);
}

export function listProviders(): OAuthProvider[] {
  return Array.from(registry.values());
}

/** Test-only: clear the registry so tests can register fresh fixtures. */
export function __resetRegistryForTests(): void {
  registry.clear();
}

// ── Built-in providers ──────────────────────────────────────────────────────
// Side-effect registration at module load. Endpoints are intentionally left
// blank — discovery fills them in at /connect time, so this stays correct
// if Notion changes URLs.
registerProvider({
  name: 'notion',
  discoveryUrl: 'https://mcp.notion.com/.well-known/oauth-authorization-server',
  scopes: [],
  usesPkce: true,
  usesDcr: true,
});
