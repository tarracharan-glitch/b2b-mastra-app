import {
  bootstrapFromEnv,
  getCredential,
  MissingCredentialError,
} from './credentialStore.ts';

// The Mastra dev bundler can reorder top-level awaits across modules, so
// relying on a side-effect import for bootstrap ordering is fragile. Cache
// the bootstrap as a lazy promise instead — the first credential read kicks
// it off; subsequent reads await the same promise. Idempotent either way.
let bootstrapPromise: Promise<void> | null = null;
function ensureBootstrap(): Promise<void> {
  bootstrapPromise ??= bootstrapFromEnv();
  return bootstrapPromise;
}

/**
 * Resolve the Tavily Authorization header at the moment a request is made.
 * Called by the MCPClient's per-request `fetch` hook so token rotation
 * (and later refresh) takes effect without restarting the agent.
 */
export async function getTavilyAuthHeader(userId: string): Promise<string> {
  await ensureBootstrap();
  const cred = await getCredential(userId, 'tavily');
  if (!cred) throw new MissingCredentialError('tavily', userId);
  return `Bearer ${cred.accessToken}`;
}
