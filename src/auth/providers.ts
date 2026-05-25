export type ProviderKind = 'oauth' | 'api_key';

export interface MCPProvider {
  /** Stable identifier used in URLs and DB rows (e.g. 'notion'). */
  name: string;
  /** How the credential is obtained. Defaults to 'oauth' if omitted. */
  kind?: ProviderKind;
  /** RFC 8414 discovery URL — `.well-known/oauth-authorization-server`. OAuth only. */
  discoveryUrl?: string;
  /** Optional fallback if no discoveryUrl is set or discovery is partial. OAuth only. */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  /** Used in Phase 5 (disconnect/revoke). OAuth only. */
  revocationEndpoint?: string;
  /** OAuth scopes to request. Empty array (or omitted) = let the provider decide. */
  scopes?: string[];
  /** MCP OAuth assumes PKCE. OAuth only. */
  usesPkce?: true;
  /** Whether RFC 7591 Dynamic Client Registration is used. OAuth only. */
  usesDcr?: boolean;
}

/** Legacy alias — keeps OAuth-specific call sites readable. */
export type OAuthProvider = MCPProvider;

export function providerKind(provider: MCPProvider): ProviderKind {
  return provider.kind ?? 'oauth';
}

const registry = new Map<string, MCPProvider>();

export function registerProvider(provider: MCPProvider): void {
  registry.set(provider.name, provider);
}

export function getProvider(name: string): MCPProvider | undefined {
  return registry.get(name);
}

export function listProviders(): MCPProvider[] {
  return Array.from(registry.values());
}

/** Test-only: clear the registry so tests can register fresh fixtures. */
export function __resetRegistryForTests(): void {
  registry.clear();
}

// ── Built-in providers ──────────────────────────────────────────────────────
// Side-effect registration at module load. OAuth endpoints are intentionally
// left blank — discovery fills them in at /connect time, so this stays
// correct if the provider changes URLs.

registerProvider({
  name: 'notion',
  kind: 'oauth',
  discoveryUrl: 'https://mcp.notion.com/.well-known/oauth-authorization-server',
  scopes: [],
  usesPkce: true,
  usesDcr: true,
});

registerProvider({
  name: 'tavily',
  kind: 'api_key',
});
