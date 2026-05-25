import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET_HINT =
  'OAUTH_STATE_SECRET must be at least 32 characters (also used for CSRF tokens).';
const BUCKET_MS = 60 * 1000;
const ACCEPTED_BUCKETS_BACK = 10; // tokens older than 10 minutes are rejected

function getSecret(): string {
  const s = process.env.OAUTH_STATE_SECRET;
  if (!s || s.length < 32) throw new Error(SECRET_HINT);
  return s;
}

function tokenForBucket(userId: string, formId: string, bucket: number): string {
  return createHmac('sha256', getSecret())
    .update(`${userId}:${formId}:${bucket}`)
    .digest('base64url');
}

/**
 * Mint a CSRF token bound to (userId, formId) and the current minute bucket.
 * Forms include this in a hidden input; the corresponding POST handler must
 * verify it via verifyCsrfToken.
 */
export function mintCsrfToken(userId: string, formId: string): string {
  return tokenForBucket(userId, formId, Math.floor(Date.now() / BUCKET_MS));
}

/**
 * Constant-time check. Accepts tokens from any of the last ACCEPTED_BUCKETS_BACK
 * minutes so a page that sits open briefly still works.
 */
export function verifyCsrfToken(provided: string, userId: string, formId: string): boolean {
  if (!provided) return false;
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(provided, 'base64url');
  } catch {
    return false;
  }
  const now = Math.floor(Date.now() / BUCKET_MS);
  for (let i = 0; i < ACCEPTED_BUCKETS_BACK; i++) {
    const expected = Buffer.from(tokenForBucket(userId, formId, now - i), 'base64url');
    if (providedBuf.length === expected.length && timingSafeEqual(providedBuf, expected)) {
      return true;
    }
  }
  return false;
}
