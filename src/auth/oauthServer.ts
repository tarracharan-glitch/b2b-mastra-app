import { Hono, type Context } from 'hono';
import { mountAdminRoutes } from './adminUi.ts';
import { setCredential } from './credentialStore.ts';
import { ensureRegisteredClient } from './dcr.ts';
import { resolveProvider } from './discovery.ts';
import { generatePkcePair } from './pkce.ts';
import { getProvider } from './providers.ts';
import { signStateJwt, StateJwtError, verifyStateJwt, type StateClaims } from './stateJwt.ts';

const VERIFIER_TTL_MS = 5 * 60 * 1000;

interface VerifierEntry {
  verifier: string;
  timer: NodeJS.Timeout;
}

const verifierCache = new Map<string, VerifierEntry>();

function stashVerifier(jti: string, verifier: string): void {
  const timer = setTimeout(() => verifierCache.delete(jti), VERIFIER_TTL_MS);
  timer.unref();
  verifierCache.set(jti, { verifier, timer });
}

function consumeVerifier(jti: string): string | undefined {
  const entry = verifierCache.get(jti);
  if (!entry) return undefined;
  clearTimeout(entry.timer);
  verifierCache.delete(jti);
  return entry.verifier;
}

function redirectBase(): string {
  return process.env.OAUTH_REDIRECT_BASE_URL ?? 'http://localhost:3000';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

function htmlError(c: Context, status: 400 | 404 | 500 | 502, message: string) {
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>OAuth error</title></head>
       <body style="font-family:system-ui,sans-serif;padding:2em;max-width:40em;margin:auto">
         <h1 style="color:#b00">OAuth error</h1>
         <p>${escapeHtml(message)}</p>
       </body></html>`,
    status,
  );
}

function htmlSuccess(c: Context, providerName: string) {
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>Connected</title>
       <script>setTimeout(() => { try { window.close(); } catch (e) {} }, 1000);</script>
     </head>
     <body style="font-family:system-ui,sans-serif;padding:2em;max-width:40em;margin:auto">
       <h1>✓ Connected ${escapeHtml(providerName)}</h1>
       <p>Token saved. You can close this tab.</p>
     </body></html>`,
    200,
  );
}

/** Extract jti from a JWT payload without verifying (verification is done elsewhere). */
function unsafeJtiFromJwt(jwt: string): string | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Partial<StateClaims>;
    return payload.jti;
  } catch {
    return undefined;
  }
}

export interface CreateAppOptions {
  /** Override the global verifier cache (useful for tests). */
  redirectBaseUrl?: string;
}

export function createOAuthApp(opts: CreateAppOptions = {}): Hono {
  const app = new Hono();
  const baseUrlOverride = opts.redirectBaseUrl;
  const getBase = (): string => baseUrlOverride ?? redirectBase();

  mountAdminRoutes(app);

  app.get('/oauth/:provider/connect', async (c) => {
    const name = c.req.param('provider');
    const userId = c.req.query('user') ?? 'default';
    const from = c.req.query('from'); // 'admin' threads through to /callback

    const baseProvider = getProvider(name);
    if (!baseProvider) return htmlError(c, 404, `unknown provider "${name}"`);

    let provider;
    try {
      provider = await resolveProvider(baseProvider);
    } catch (err) {
      return htmlError(c, 502, `discovery failed: ${(err as Error).message}`);
    }
    if (!provider.authorizationEndpoint || !provider.tokenEndpoint) {
      return htmlError(c, 500, `provider "${name}" lacks authorization_endpoint or token_endpoint`);
    }

    const redirectUri = `${getBase()}/oauth/${name}/callback`;

    let clientRecord;
    try {
      clientRecord = await ensureRegisteredClient(provider, redirectUri);
    } catch (err) {
      return htmlError(c, 502, `client registration failed: ${(err as Error).message}`);
    }

    const { verifier, challenge, method } = generatePkcePair();
    const ext = from === 'admin' ? { from: 'admin' } : undefined;
    const state = signStateJwt({ sub: userId, provider: name, ext });
    const jti = unsafeJtiFromJwt(state);
    if (!jti) return htmlError(c, 500, 'failed to extract jti from signed state');
    stashVerifier(jti, verifier);

    const scopes = provider.scopes ?? [];
    const authUrl = new URL(provider.authorizationEndpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientRecord.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    if (scopes.length) authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', method);

    return c.redirect(authUrl.toString(), 302);
  });

  app.get('/oauth/:provider/callback', async (c) => {
    const name = c.req.param('provider');
    const code = c.req.query('code');
    const state = c.req.query('state');
    const providerErr = c.req.query('error');
    const providerErrDesc = c.req.query('error_description');

    if (providerErr) {
      return htmlError(c, 400, `provider returned error: ${providerErr} ${providerErrDesc ?? ''}`.trim());
    }
    if (!code || !state) return htmlError(c, 400, 'missing code or state in callback');

    let claims;
    try {
      claims = verifyStateJwt(state);
    } catch (err) {
      const detail =
        err instanceof StateJwtError ? `${err.code}: ${err.message}` : (err as Error).message;
      return htmlError(c, 400, `invalid state (${detail})`);
    }
    if (claims.provider !== name) {
      return htmlError(c, 400, `state/provider mismatch: jwt says "${claims.provider}", URL says "${name}"`);
    }

    const verifier = consumeVerifier(claims.jti);
    if (!verifier) {
      return htmlError(c, 400, 'no PKCE verifier for this state (expired or already consumed)');
    }

    const baseProvider = getProvider(name);
    if (!baseProvider) return htmlError(c, 404, `unknown provider "${name}"`);

    let provider;
    try {
      provider = await resolveProvider(baseProvider);
    } catch (err) {
      return htmlError(c, 502, `discovery failed: ${(err as Error).message}`);
    }
    if (!provider.tokenEndpoint) return htmlError(c, 500, 'no token_endpoint configured');

    const redirectUri = `${getBase()}/oauth/${name}/callback`;
    let clientRecord;
    try {
      clientRecord = await ensureRegisteredClient(provider, redirectUri);
    } catch (err) {
      return htmlError(c, 502, `client lookup failed: ${(err as Error).message}`);
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('redirect_uri', redirectUri);
    body.set('code_verifier', verifier);
    body.set('client_id', clientRecord.clientId);
    if (clientRecord.clientSecret) body.set('client_secret', clientRecord.clientSecret);

    let tokenRes;
    try {
      tokenRes = await fetch(provider.tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      });
    } catch (err) {
      return htmlError(c, 502, `token endpoint unreachable: ${(err as Error).message}`);
    }
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return htmlError(c, 502, `token exchange failed (${tokenRes.status}): ${text}`);
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
      [k: string]: unknown;
    };

    if (!tokens.access_token) {
      return htmlError(c, 502, 'token endpoint did not return access_token');
    }

    await setCredential(claims.sub, name, {
      kind: 'oauth',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in
        ? Math.floor(Date.now() / 1000) + tokens.expires_in
        : undefined,
      scope: tokens.scope,
      metadata: tokens.token_type ? { tokenType: tokens.token_type } : undefined,
    });

    // If the original /connect was initiated from /admin, redirect back to
    // /admin with a flash instead of rendering the standalone success page.
    if (claims.ext && (claims.ext as Record<string, unknown>).from === 'admin') {
      const adminUrl = new URL(`${getBase()}/admin`);
      adminUrl.searchParams.set('user', claims.sub);
      adminUrl.searchParams.set('flash', `connected:${name}`);
      return c.redirect(adminUrl.toString(), 303);
    }

    return htmlSuccess(c, name);
  });

  return app;
}
