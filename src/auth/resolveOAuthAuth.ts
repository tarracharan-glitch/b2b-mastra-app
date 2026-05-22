import { getCredential, MissingCredentialError } from './credentialStore.ts';

/** Window before actual expiry that we treat a token as already expired. */
const EXPIRY_CUSHION_SECONDS = 60;

export class ExpiredCredentialError extends Error {
  readonly provider: string;
  readonly userId: string;
  readonly expiresAt: number;
  constructor(provider: string, userId: string, expiresAt: number) {
    super(
      `Credential for provider="${provider}" user="${userId}" is expired or expiring soon ` +
        `(expires_at=${new Date(expiresAt * 1000).toISOString()}). ` +
        `Phase 5 will refresh automatically; for now, reconnect with:  ` +
        `npm run connect -- --provider ${provider} --user ${userId}`,
    );
    this.name = 'ExpiredCredentialError';
    this.provider = provider;
    this.userId = userId;
    this.expiresAt = expiresAt;
  }
}

/**
 * Resolve the Authorization header for any OAuth-backed provider at request time.
 *
 * Phase 4 behavior: if the credential is missing or already expired, throw a
 * typed, actionable error. Phase 5 will refresh transparently.
 */
export async function getOAuthAuthHeader(userId: string, provider: string): Promise<string> {
  const cred = await getCredential(userId, provider);
  if (!cred) {
    throw new MissingCredentialError(
      provider,
      userId,
      `npm run connect -- --provider ${provider} --user ${userId}`,
    );
  }

  if (cred.expiresAt && cred.expiresAt - EXPIRY_CUSHION_SECONDS < Math.floor(Date.now() / 1000)) {
    // Phase 5: refreshOAuthToken(userId, provider) goes here and returns the
    // new access token. For now, fail clearly so the user reconnects.
    throw new ExpiredCredentialError(provider, userId, cred.expiresAt);
  }

  return `Bearer ${cred.accessToken}`;
}
