import { serve, type ServerType } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';

const tempDir = mkdtempSync(join(tmpdir(), 'admin-ui-test-'));
process.env.AUTH_DB_URL = `file:${join(tempDir, 'auth.db')}`;
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.OAUTH_STATE_SECRET = randomBytes(48).toString('base64');

const { createOAuthApp } = await import('../src/auth/oauthServer.ts');
const { registerProvider, __resetRegistryForTests } = await import('../src/auth/providers.ts');
const { __resetDiscoveryCacheForTests } = await import('../src/auth/discovery.ts');
const { mintCsrfToken } = await import('../src/auth/csrf.ts');
const { setCredential, getCredential } = await import('../src/auth/credentialStore.ts');
const { cacheClient, deleteCachedClient } = await import('../src/auth/oauthClients.ts');

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

// ── Fake OAuth provider for the connect-from-admin happy path ───────────────

interface FakeState {
  baseUrl: string;
  tokenResponseQueue: Array<Record<string, unknown>>;
  lastTokenRequest?: URLSearchParams;
}

function buildFake(state: FakeState): Hono {
  const app = new Hono();
  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      authorization_endpoint: `${state.baseUrl}/authorize`,
      token_endpoint: `${state.baseUrl}/token`,
      registration_endpoint: `${state.baseUrl}/register`,
      revocation_endpoint: `${state.baseUrl}/revoke`,
    }),
  );
  app.post('/register', (c) => c.json({ client_id: 'fake-cid-admin' }));
  app.post('/token', async (c) => {
    state.lastTokenRequest = new URLSearchParams(await c.req.text());
    const next = state.tokenResponseQueue.shift() ?? {
      access_token: 'fake-access',
      refresh_token: 'fake-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    };
    return c.json(next);
  });
  return app;
}

async function startFake(): Promise<{ url: string; state: FakeState; close: () => Promise<void> }> {
  const state: FakeState = { baseUrl: '', tokenResponseQueue: [] };
  const app = buildFake(state);
  return new Promise((resolve) => {
    let server: ServerType;
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      state.baseUrl = `http://127.0.0.1:${info.port}`;
      resolve({
        url: state.baseUrl,
        state,
        close: () => new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

function setupRegistry(opts: { withFakeOauth?: string } = {}): void {
  __resetRegistryForTests();
  __resetDiscoveryCacheForTests();
  // Tavily-style api_key provider
  registerProvider({ name: 'localkey', kind: 'api_key' });
  // OAuth provider with no real backend (just for /connect routing tests)
  registerProvider({ name: 'fauxoauth', kind: 'oauth', scopes: [] });
  if (opts.withFakeOauth) {
    registerProvider({
      name: 'realoauth',
      kind: 'oauth',
      discoveryUrl: `${opts.withFakeOauth}/.well-known/oauth-authorization-server`,
      scopes: [],
      usesPkce: true,
      usesDcr: true,
    });
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

try {
  console.log('admin UI tests');

  await test('GET /admin renders cleanly with zero credentials (all "not connected")', async () => {
    setupRegistry();
    const app = createOAuthApp({ redirectBaseUrl: 'http://test.invalid' });
    const res = await app.fetch(new Request('http://test.invalid/admin?user=default'));
    assert(res.status === 200, `status: ${res.status}`);
    const html = await res.text();
    assert(html.includes('MCP providers'), 'has heading');
    assert(html.includes('localkey'), 'lists localkey');
    assert(html.includes('fauxoauth'), 'lists fauxoauth');
    // Both providers should be in the "not connected" state.
    const notConnectedMatches = html.match(/not connected/g) ?? [];
    assert(notConnectedMatches.length >= 2, `expected 2 'not connected' badges, got ${notConnectedMatches.length}`);
    // Banner present
    assert(html.includes('src/auth/providers.ts'), 'banner mentions providers.ts');
  });

  await test('POST /admin/disconnect for a provider with no row -> 303 with clean flash', async () => {
    setupRegistry();
    const app = createOAuthApp({ redirectBaseUrl: 'http://test.invalid' });
    const csrf = mintCsrfToken('alice', 'disconnect:localkey');
    const body = new URLSearchParams({ user: 'alice', csrf }).toString();
    const res = await app.fetch(
      new Request('http://test.invalid/admin/disconnect/localkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }),
    );
    assert(res.status === 303, `status: ${res.status}`);
    const loc = res.headers.get('Location')!;
    assert(loc.includes('flash=disconnected'), `location: ${loc}`);
    assert(loc.includes('user=alice'), 'redirect preserves user');
  });

  await test('CSRF mismatch -> 403 with reload message', async () => {
    setupRegistry();
    const app = createOAuthApp({ redirectBaseUrl: 'http://test.invalid' });
    const wrongCsrf = mintCsrfToken('alice', 'disconnect:WRONG'); // bound to different formId
    const body = new URLSearchParams({ user: 'alice', csrf: wrongCsrf }).toString();
    const res = await app.fetch(
      new Request('http://test.invalid/admin/disconnect/localkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }),
    );
    assert(res.status === 403, `status: ${res.status}`);
    const html = await res.text();
    assert(html.includes('Reload') || html.includes('reload'), 'tells user to reload');
  });

  await test('POST without csrf -> 403', async () => {
    setupRegistry();
    const app = createOAuthApp({ redirectBaseUrl: 'http://test.invalid' });
    const body = new URLSearchParams({ user: 'alice' }).toString();
    const res = await app.fetch(
      new Request('http://test.invalid/admin/disconnect/localkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }),
    );
    assert(res.status === 403, `status: ${res.status}`);
  });

  await test('user selector includes all distinct user_ids from the table', async () => {
    setupRegistry();
    await setCredential('alice', 'localkey', { kind: 'api_key', accessToken: 'a' });
    await setCredential('bob', 'localkey', { kind: 'api_key', accessToken: 'b' });
    await setCredential('carol', 'fauxoauth', {
      kind: 'oauth',
      accessToken: 'c',
      refreshToken: 'r',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const app = createOAuthApp({ redirectBaseUrl: 'http://test.invalid' });
    const res = await app.fetch(new Request('http://test.invalid/admin?user=alice'));
    const html = await res.text();
    for (const u of ['alice', 'bob', 'carol']) {
      assert(html.includes(`value="${u}"`), `select option for ${u}`);
    }
  });

  await test('connect for oauth provider -> 303 to /oauth/<p>/connect with from=admin', async () => {
    setupRegistry();
    const app = createOAuthApp({ redirectBaseUrl: 'http://test.invalid' });
    const csrf = mintCsrfToken('default', 'connect:fauxoauth');
    const body = new URLSearchParams({ user: 'default', csrf }).toString();
    const res = await app.fetch(
      new Request('http://test.invalid/admin/connect/fauxoauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }),
    );
    assert(res.status === 303, `status: ${res.status}`);
    const loc = res.headers.get('Location')!;
    assert(loc.startsWith('/oauth/fauxoauth/connect'), `location: ${loc}`);
    assert(loc.includes('from=admin'), 'redirect carries from=admin');
    assert(loc.includes('user=default'), 'redirect carries user');
  });

  await test('connect for api_key provider renders inline form; submit creates row + flash', async () => {
    setupRegistry();
    const app = createOAuthApp({ redirectBaseUrl: 'http://test.invalid' });

    // POST /admin/connect/localkey -> renders form (HTML, not redirect)
    const connectCsrf = mintCsrfToken('default', 'connect:localkey');
    const connectBody = new URLSearchParams({ user: 'default', csrf: connectCsrf }).toString();
    const formPage = await app.fetch(
      new Request('http://test.invalid/admin/connect/localkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: connectBody,
      }),
    );
    assert(formPage.status === 200, `connect form status: ${formPage.status}`);
    const formHtml = await formPage.text();
    assert(formHtml.includes('Set API key for'), 'form heading');
    assert(formHtml.includes('action="/admin/credentials/localkey"'), 'form posts to credentials');
    assert(formHtml.includes('name="csrf"'), 'form has csrf input');

    // Now submit the credential form.
    const credCsrf = mintCsrfToken('default', 'credentials:localkey');
    const credBody = new URLSearchParams({
      user: 'default',
      csrf: credCsrf,
      token: 'tvly-fresh',
    }).toString();
    const credRes = await app.fetch(
      new Request('http://test.invalid/admin/credentials/localkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: credBody,
      }),
    );
    assert(credRes.status === 303, `submit status: ${credRes.status}`);
    const loc = credRes.headers.get('Location')!;
    assert(loc.includes('flash=connected'), `location: ${loc}`);

    const stored = await getCredential('default', 'localkey');
    assert(stored?.accessToken === 'tvly-fresh', 'token persisted');
    assert(stored?.kind === 'api_key', 'kind matches provider');
  });

  await test('OAuth /callback initiated from admin redirects to /admin with flash', async () => {
    setupRegistry();
    await deleteCachedClient('realoauth');
    const fake = await startFake();
    try {
      __resetDiscoveryCacheForTests();
      registerProvider({
        name: 'realoauth',
        kind: 'oauth',
        discoveryUrl: `${fake.url}/.well-known/oauth-authorization-server`,
        scopes: [],
        usesPkce: true,
        usesDcr: true,
      });

      const app = createOAuthApp({ redirectBaseUrl: 'http://test.invalid' });

      // Step 1: /connect with from=admin
      const connect = await app.fetch(
        new Request('http://test.invalid/oauth/realoauth/connect?user=alice&from=admin'),
      );
      assert(connect.status === 302, `connect status: ${connect.status}`);
      const authorize = new URL(connect.headers.get('Location')!);
      const state = authorize.searchParams.get('state')!;
      assert(state, 'state present');

      // Step 2: simulate provider redirecting back to /callback
      const cbUrl = `http://test.invalid/oauth/realoauth/callback?code=test-code&state=${encodeURIComponent(state)}`;
      const cb = await app.fetch(new Request(cbUrl));
      assert(cb.status === 303, `callback should 303 (admin), got: ${cb.status}`);
      const loc = cb.headers.get('Location')!;
      assert(loc.includes('/admin'), `redirect to /admin, got: ${loc}`);
      assert(loc.includes('flash=connected%3Arealoauth') || loc.includes('flash=connected:realoauth'), `flash present: ${loc}`);

      // Credential row exists.
      const cred = await getCredential('alice', 'realoauth');
      assert(cred?.accessToken === 'fake-access', 'token written');
    } finally {
      await fake.close();
    }
  });

  await test('refresh button form posts to /admin/refresh and is CSRF-bound', async () => {
    setupRegistry();
    await cacheClient('fauxoauth', { clientId: 'noop' });
    await setCredential('alice', 'fauxoauth', {
      kind: 'oauth',
      accessToken: 'ok',
      refreshToken: 'r',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const app = createOAuthApp({ redirectBaseUrl: 'http://test.invalid' });

    // Hitting refresh without a valid CSRF should be rejected.
    const bad = await app.fetch(
      new Request('http://test.invalid/admin/refresh/fauxoauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'user=alice&csrf=nope',
      }),
    );
    assert(bad.status === 403, `bad csrf -> 403, got ${bad.status}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
