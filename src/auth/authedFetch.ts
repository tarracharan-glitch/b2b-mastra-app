import type { MastraFetchLike } from '@mastra/mcp';

export interface AuthedFetchOptions {
  /**
   * Returns the Authorization header for the normal request path. For OAuth
   * providers this may internally refresh when the token is close to expiry.
   */
  getHeader: () => Promise<string>;
  /**
   * Returns the Authorization header when a previous request returned 401.
   * For OAuth providers this should force a refresh; for static API keys
   * it can just re-read from the credential store to pick up a rotated key.
   */
  refreshHeader: () => Promise<string>;
}

/**
 * Wrap a Mastra MCP `fetch` hook with two behaviors:
 *   1. Attach a fresh Authorization header per request via `getHeader`.
 *   2. If the server returns 401, refresh the credential once and retry.
 *
 * The retry is bounded to a single attempt — if the second response is also
 * 401, the second response is returned so the caller sees the failure.
 */
export function authedFetch(opts: AuthedFetchOptions): MastraFetchLike {
  return async (url, init) => {
    const baseHeaders = new Headers(init?.headers);
    baseHeaders.set('Authorization', await opts.getHeader());
    let res = await fetch(url, { ...init, headers: baseHeaders });

    if (res.status !== 401) return res;

    // Single forced retry. If the refresh itself throws, let it propagate so
    // the caller surfaces the typed error (RefreshFailedError /
    // CannotRefreshError) — that's more useful than masking it with a 401.
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('Authorization', await opts.refreshHeader());
    return fetch(url, { ...init, headers: retryHeaders });
  };
}
