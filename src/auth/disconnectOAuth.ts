import { deleteCredential, getCredential } from './credentialStore.ts';
import { resolveProvider } from './discovery.ts';
import { getCachedClient } from './oauthClients.ts';
import { getProvider } from './providers.ts';

export interface DisconnectResult {
  /** Whether a credential row existed before disconnect. */
  hadCredential: boolean;
  /** Whether the credential row is gone after the call (always true on success). */
  deleted: boolean;
  /** Whether a revocation request was attempted. */
  revokeAttempted: boolean;
  /** HTTP status returned by the revocation endpoint, if attempted. */
  revokeStatus?: number;
  /** Discovered revocation endpoint, if any. */
  revokeEndpoint?: string;
  /** Provider-side error text on a non-2xx revoke response. */
  revokeError?: string;
  /** Free-form notes for the CLI to print. */
  notes: string[];
}

/**
 * Disconnect a provider for a user.
 *
 * Best-effort revocation per RFC 7009: if the provider advertises a
 * revocation_endpoint, POST the access token there. Provider responses vary
 * widely (Notion's revocation endpoint is the same as the token endpoint),
 * so the local row is deleted regardless of the response — even on 5xx the
 * user wants to be disconnected locally.
 */
export async function disconnectOAuth(
  userId: string,
  provider: string,
): Promise<DisconnectResult> {
  const notes: string[] = [];
  const cred = await getCredential(userId, provider);

  if (!cred) {
    return {
      hadCredential: false,
      deleted: false,
      revokeAttempted: false,
      notes: [`no credential row for (user=${userId}, provider=${provider}) — nothing to do`],
    };
  }

  let revokeAttempted = false;
  let revokeStatus: number | undefined;
  let revokeEndpoint: string | undefined;
  let revokeError: string | undefined;

  const baseProvider = getProvider(provider);
  if (baseProvider) {
    try {
      const resolved = await resolveProvider(baseProvider);
      if (resolved.revocationEndpoint) {
        revokeEndpoint = resolved.revocationEndpoint;
        revokeAttempted = true;
        const clientRecord = await getCachedClient(provider);
        const body = new URLSearchParams();
        body.set('token', cred.accessToken);
        body.set('token_type_hint', 'access_token');
        if (clientRecord) {
          body.set('client_id', clientRecord.clientId);
          if (clientRecord.clientSecret) body.set('client_secret', clientRecord.clientSecret);
        }
        try {
          const res = await fetch(resolved.revocationEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          });
          revokeStatus = res.status;
          if (!res.ok) {
            revokeError = await res.text().catch(() => '');
            notes.push(
              `revoke returned ${res.status} — provider may have already invalidated the grant`,
            );
          } else {
            notes.push(`revoke succeeded (${res.status})`);
          }
        } catch (err) {
          revokeError = (err as Error).message;
          notes.push(`revoke network error: ${(err as Error).message} (deleting local row anyway)`);
        }
      } else {
        notes.push(`provider "${provider}" has no revocation_endpoint — deleting local row only`);
      }
    } catch (err) {
      // Discovery failures shouldn't block disconnect.
      notes.push(
        `discovery failed during revoke (${(err as Error).message}) — deleting local row anyway`,
      );
    }
  } else {
    notes.push(`provider "${provider}" is not in the registry — deleting local row only`);
  }

  // Always delete locally regardless of revoke outcome.
  await deleteCredential(userId, provider);
  notes.push(`deleted credential row for (user=${userId}, provider=${provider})`);

  return {
    hadCredential: true,
    deleted: true,
    revokeAttempted,
    revokeStatus,
    revokeEndpoint,
    revokeError,
    notes,
  };
}
