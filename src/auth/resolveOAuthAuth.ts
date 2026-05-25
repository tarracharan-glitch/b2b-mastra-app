import { getCredential, MissingCredentialError } from './credentialStore.ts';
import { refreshOAuthToken } from './refreshOAuthToken.ts';

/** Window before actual expiry that we treat a token as already expired. */
const EXPIRY_CUSHION_SECONDS = 60;

export interface ResolveOptions {
  /** Skip the cushion check and force a refresh up front. Used by retry-on-401. */
  force?: boolean;
}

/**
 * Return a valid access token for (userId, provider), refreshing transparently
 * when it's expired or close to expiring. Throws MissingCredentialError if no
 * row exists; throws CannotRefreshError / RefreshFailedError if a refresh is
 * required but can't complete.
 */
export async function refreshIfNeeded(
  userId: string,
  provider: string,
  opts: ResolveOptions = {},
): Promise<string> {
  const cred = await getCredential(userId, provider);
  if (!cred) {
    throw new MissingCredentialError(
      provider,
      userId,
      `npm run connect -- --provider ${provider} --user ${userId}`,
    );
  }

  // Forced refresh path (used by retry-on-401 wrappers).
  if (opts.force) return refreshOAuthToken(userId, provider);

  // No expiry -> assume long-lived, hand back as-is.
  if (!cred.expiresAt) return cred.accessToken;

  const now = Math.floor(Date.now() / 1000);
  if (cred.expiresAt - EXPIRY_CUSHION_SECONDS > now) return cred.accessToken;

  return refreshOAuthToken(userId, provider);
}

/**
 * Resolve the Authorization header for any OAuth-backed provider at request time.
 * Calls refreshIfNeeded internally; see that function for failure modes.
 */
export async function getOAuthAuthHeader(
  userId: string,
  provider: string,
  opts: ResolveOptions = {},
): Promise<string> {
  const token = await refreshIfNeeded(userId, provider, opts);
  return `Bearer ${token}`;
}
