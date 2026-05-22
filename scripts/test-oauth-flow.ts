import { serve, type ServerType } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';

// Per-test env BEFORE importing any auth modules — they cache the DB
// connection at first access.
const tempDir = mkdtempSync(join(tmpdir(), 'oauth-flow-test-'));
process.env.AUTH_DB_URL = `file:${join(tempDir, 'auth.db')}`;
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.OAUTH_STATE_SECRET = randomBytes(48).toString('base64');

const { createOAuthApp } = await import('../src/auth/oauthServer.ts');
const { registerProvider, __resetRegistryForTests } = await import('../src/auth/providers.ts');
const { __resetDiscoveryCacheForTests } = await import('../src/auth/discovery.ts');
const { signStateJwt } = await import('../src/auth/stateJwt.ts');
const { getCredential } = await import('../src/auth/credentialStore.ts');
const { getCachedClient, deleteCachedClient } = await import('../src/auth/oauthClients.ts');

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${(err as Error).stack ?? (err as Error).message}`);
    failed++;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// ── Fake provider server ────────────────────────────────────────────────────
// Implements:
//   GET  /.well-known/oauth-authorization-server  -> discovery doc
//   POST /register                                -> DCR, returns client_id
//   GET  /authorize                               -> never actually visited in
//                                                    tests (we synthesize the
//                                                    callback URL directly)
//   POST /token                                   -> returns access+refresh
//
// State held in-process: lastTokenRequestBody for assertions.

interface FakeProviderState {
  baseUrl: string;
  lastTokenRequest?: URLSearchParams;
  tokenResponses: Array<Record<string, unknown>>;
  dcrShouldFail?: boolean;
}

function buildFakeProvider(state: FakeProviderState): Hono {
  const app = new Hono();

  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      authorization_endpoint: `${state.baseUrl}/authorize`,
      token_endpoint: `${state.baseUrl}/token`,
      registration_endpoint: `${state.baseUrl}/register`,
      revocation_endpoint: `${state.baseUrl}/revoke`,
    }),
  );

  app.post('/register', async (c) => {
    if (state.dcrShouldFail) return c.text('register busted', 500);
    const body = await c.req.json();
    return c.json({
      client_id: 'fake-client-id-123',
      client_name: body.client_name,
      redirect_uris: body.redirect_uris,
      registration_access_token: 'fake-rat',
    });
  });

  app.post('/token', async (c) => {
    const text = await c.req.text();
    state.lastTokenRequest = new URLSearchParams(text);
    const resp = state.tokenResponses.shift() ?? {
      access_token: 'fake-access-default',
      refresh_token: 'fake-refresh-default',
      expires_in: 3600,
      scope: 'read write',
      token_type: 'Bearer',
    };
    return c.json(resp);
  });

  return app;
}

interface RunningFake {
  url: string;
  state: FakeProviderState;
  close: () => Promise<void>;
}

async function startFakeProvider(): Promise<RunningFake> {
  const state: FakeProviderState = { baseUrl: '', tokenResponses: [] };
  const app = buildFakeProvider(state);
  return new Promise((resolve) => {
    let server: ServerType;
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      state.baseUrl = `http://127.0.0.1:${info.port}`;
      resolve({
        url: state.baseUrl,
        state,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractStateFromAuthorizeRedirect(location: string): string {
  const u = new URL(location);
  const state = u.searchParams.get('state');
  if (!state) throw new Error(`no state in redirect: ${location}`);
  return state;
}

// ── Tests ───────────────────────────────────────────────────────────────────

try {
  console.log('oauthServer tests');

  // Each test resets registry + discovery cache + DCR cache + verifier state
  // (new app instance) for isolation.

  await test('successful flow: /connect -> /callback writes a credential row', async () => {
    __resetRegistryForTests();
    __resetDiscoveryCacheForTests();
    await deleteCachedClient('fakeprov');

    const fake = await startFakeProvider();
    try {
      registerProvider({
        name: 'fakeprov',
        discoveryUrl: `${fake.url}/.well-known/oauth-authorization-server`,
        scopes: ['read', 'write'],
        usesPkce: true,
        usesDcr: true,
      });

      const app = createOAuthApp({ redirectBaseUrl: 'http://test-callback.invalid' });

      // 1. /connect — should 302 to fake authorize URL
      const connectRes = await app.fetch(
        new Request('http://oauth.test/oauth/fakeprov/connect?user=alice'),
      );
      assert(connectRes.status === 302, `connect status: ${connectRes.status}`);
      const location = connectRes.headers.get('Location')!;
      assert(location.startsWith(`${fake.url}/authorize?`), `redirect target: ${location}`);
      const state = extractStateFromAuthorizeRedirect(location);

      // Cached DCR client should exist now
      const client = await getCachedClient('fakeprov');
      assert(client?.clientId === 'fake-client-id-123', 'DCR cached');

      // 2. /callback — simulate provider redirecting back with code+state
      const callbackUrl =
        `http://oauth.test/oauth/fakeprov/callback?code=fake-auth-code&state=${encodeURIComponent(state)}`;
      const cbRes = await app.fetch(new Request(callbackUrl));
      assert(cbRes.status === 200, `callback status: ${cbRes.status}`);
      const html = await cbRes.text();
      assert(html.includes('Connected'), 'success page rendered');

      // 3. The token endpoint received PKCE verifier + code
      const body = fake.state.lastTokenRequest!;
      assert(body.get('grant_type') === 'authorization_code', 'grant_type');
      assert(body.get('code') === 'fake-auth-code', 'code forwarded');
      assert(body.get('code_verifier'), 'code_verifier sent');
      assert(body.get('client_id') === 'fake-client-id-123', 'client_id');
      assert(
        body.get('redirect_uri') === 'http://test-callback.invalid/oauth/fakeprov/callback',
        'redirect_uri matches',
      );

      // 4. Credential row was written
      const cred = await getCredential('alice', 'fakeprov');
      assert(cred?.kind === 'oauth', 'kind=oauth');
      assert(cred?.accessToken === 'fake-access-default', 'access token saved');
      assert(cred?.refreshToken === 'fake-refresh-default', 'refresh token saved');
      assert(cred?.expiresAt && cred.expiresAt > Math.floor(Date.now() / 1000), 'expiry in the future');
      assert(cred?.scope === 'read write', 'scope saved');
    } finally {
      await fake.close();
    }
  });

  await test('tampered state JWT -> 400 error page', async () => {
    __resetRegistryForTests();
    __resetDiscoveryCacheForTests();
    await deleteCachedClient('fakeprov');

    const fake = await startFakeProvider();
    try {
      registerProvider({
        name: 'fakeprov',
        discoveryUrl: `${fake.url}/.well-known/oauth-authorization-server`,
        scopes: [],
        usesPkce: true,
        usesDcr: true,
      });
      const app = createOAuthApp({ redirectBaseUrl: 'http://test-callback.invalid' });

      const goodState = signStateJwt({ sub: 'alice', provider: 'fakeprov' });
      // Flip a bit in the signature segment
      const parts = goodState.split('.');
      const sigBytes = Buffer.from(parts[2]!, 'base64url');
      sigBytes[0] = sigBytes[0]! ^ 0x01;
      const tamperedState = `${parts[0]}.${parts[1]}.${sigBytes.toString('base64url')}`;

      const res = await app.fetch(
        new Request(
          `http://oauth.test/oauth/fakeprov/callback?code=anycode&state=${encodeURIComponent(tamperedState)}`,
        ),
      );
      assert(res.status === 400, `tamper status: ${res.status}`);
      const html = await res.text();
      assert(html.includes('bad_signature') || html.includes('invalid state'), 'tamper message');
    } finally {
      await fake.close();
    }
  });

  await test('expired state JWT -> 400 error page', async () => {
    __resetRegistryForTests();
    __resetDiscoveryCacheForTests();
    await deleteCachedClient('fakeprov');

    const fake = await startFakeProvider();
    try {
      registerProvider({
        name: 'fakeprov',
        discoveryUrl: `${fake.url}/.well-known/oauth-authorization-server`,
        scopes: [],
        usesPkce: true,
        usesDcr: true,
      });
      const app = createOAuthApp({ redirectBaseUrl: 'http://test-callback.invalid' });

      // ttlSeconds: -10 -> exp is 10s in the past
      const expiredState = signStateJwt({
        sub: 'alice',
        provider: 'fakeprov',
        ttlSeconds: -10,
      });

      const res = await app.fetch(
        new Request(
          `http://oauth.test/oauth/fakeprov/callback?code=anycode&state=${encodeURIComponent(expiredState)}`,
        ),
      );
      assert(res.status === 400, `expired status: ${res.status}`);
      const html = await res.text();
      assert(html.includes('expired') || html.includes('invalid state'), 'expired message');
    } finally {
      await fake.close();
    }
  });

  await test('verifier replay: second /callback with same state fails (verifier consumed)', async () => {
    __resetRegistryForTests();
    __resetDiscoveryCacheForTests();
    await deleteCachedClient('fakeprov');

    const fake = await startFakeProvider();
    try {
      registerProvider({
        name: 'fakeprov',
        discoveryUrl: `${fake.url}/.well-known/oauth-authorization-server`,
        scopes: ['read'],
        usesPkce: true,
        usesDcr: true,
      });
      const app = createOAuthApp({ redirectBaseUrl: 'http://test-callback.invalid' });

      const connectRes = await app.fetch(
        new Request('http://oauth.test/oauth/fakeprov/connect?user=replay-user'),
      );
      const state = extractStateFromAuthorizeRedirect(connectRes.headers.get('Location')!);

      // First callback: succeeds
      const cb1 = await app.fetch(
        new Request(
          `http://oauth.test/oauth/fakeprov/callback?code=code1&state=${encodeURIComponent(state)}`,
        ),
      );
      assert(cb1.status === 200, `first callback: ${cb1.status}`);

      // Second callback with same state: verifier was consumed
      const cb2 = await app.fetch(
        new Request(
          `http://oauth.test/oauth/fakeprov/callback?code=code2&state=${encodeURIComponent(state)}`,
        ),
      );
      assert(cb2.status === 400, `replay status: ${cb2.status}`);
      const html = await cb2.text();
      assert(html.includes('already consumed') || html.includes('no PKCE verifier'), 'replay message');
    } finally {
      await fake.close();
    }
  });

  await test('unknown provider -> 404 error page', async () => {
    __resetRegistryForTests();
    const app = createOAuthApp({ redirectBaseUrl: 'http://test-callback.invalid' });
    const res = await app.fetch(new Request('http://oauth.test/oauth/no-such-provider/connect?user=x'));
    assert(res.status === 404, `404 status: ${res.status}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
