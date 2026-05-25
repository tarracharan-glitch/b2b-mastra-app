import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/**
 * RFC 7636 PKCE pair.
 * verifier: 32 random bytes, base64url-encoded (43 chars, well above the
 *           43-128 char range the RFC requires).
 * challenge: SHA-256(verifier), base64url-encoded.
 */
export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}
