import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const ALG = 'HS256';
const TTL_SECONDS = 5 * 60;
const SECRET_HINT =
  'OAUTH_STATE_SECRET must be at least 32 characters. ' +
  'Generate one with:  openssl rand -base64 32';

export interface StateClaims {
  sub: string; // userId
  provider: string;
  jti: string;
  nonce: string;
  /** Optional: free-form payload used by callers (e.g. /admin to add `from=admin`). */
  ext?: Record<string, unknown>;
  iat: number;
  exp: number;
}

export class StateJwtError extends Error {
  readonly code: 'bad_signature' | 'expired' | 'malformed';
  constructor(code: 'bad_signature' | 'expired' | 'malformed', message: string) {
    super(message);
    this.code = code;
    this.name = 'StateJwtError';
  }
}

function getSecret(): string {
  const s = process.env.OAUTH_STATE_SECRET;
  if (!s || s.length < 32) throw new Error(SECRET_HINT);
  return s;
}

function b64uEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function b64uDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export interface SignInput {
  sub: string;
  provider: string;
  ext?: Record<string, unknown>;
  jti?: string;
  nonce?: string;
  ttlSeconds?: number;
}

export function signStateJwt(input: SignInput): string {
  const secret = getSecret();
  const now = Math.floor(Date.now() / 1000);
  const claims: StateClaims = {
    sub: input.sub,
    provider: input.provider,
    jti: input.jti ?? randomUUID(),
    nonce: input.nonce ?? randomUUID(),
    ext: input.ext,
    iat: now,
    exp: now + (input.ttlSeconds ?? TTL_SECONDS),
  };
  const header = b64uEncode(JSON.stringify({ alg: ALG, typ: 'JWT' }));
  const payload = b64uEncode(JSON.stringify(claims));
  const signing = `${header}.${payload}`;
  const sig = createHmac('sha256', secret).update(signing).digest('base64url');
  return `${signing}.${sig}`;
}

export function verifyStateJwt(token: string): StateClaims {
  const secret = getSecret();
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new StateJwtError('malformed', 'expected 3 dot-separated segments');
  }
  const [header, payload, signature] = parts as [string, string, string];

  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  const sigBuf = b64uDecode(signature);
  const expBuf = b64uDecode(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new StateJwtError('bad_signature', 'signature mismatch');
  }

  let claims: StateClaims;
  try {
    claims = JSON.parse(b64uDecode(payload).toString('utf8')) as StateClaims;
  } catch (err) {
    throw new StateJwtError('malformed', `payload is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof claims.exp !== 'number') {
    throw new StateJwtError('malformed', 'missing exp claim');
  }
  if (claims.exp < Math.floor(Date.now() / 1000)) {
    throw new StateJwtError('expired', 'token expired');
  }
  return claims;
}
