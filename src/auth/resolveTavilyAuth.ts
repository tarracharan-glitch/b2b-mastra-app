import { getCredential, MissingCredentialError } from './credentialStore.ts';

/**
 * Resolve the Tavily Authorization header at the moment a request is made.
 * Called by the MCPClient's per-request `fetch` hook so a rotated API key
 * takes effect on the next call without restarting the agent.
 */
export async function getTavilyAuthHeader(userId: string): Promise<string> {
  const cred = await getCredential(userId, 'tavily');
  if (!cred) throw new MissingCredentialError('tavily', userId);
  return `Bearer ${cred.accessToken}`;
}
