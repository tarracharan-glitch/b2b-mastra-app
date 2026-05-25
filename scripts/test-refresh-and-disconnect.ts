import { serve, type ServerType } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';

const tempDir = mkdtempSync(join(tmpdir(), 'refresh-disconnect-test-'));
process.env.AUTH_DB_URL = `file:${join(tempDir, 'auth.db')}`;
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.OAUTH_STATE_SECRET = randomBytes(48).toString('base64');

const {
  getCredential,
  setCredential,
  deleteCredential,
  MissingCredentialError,
} = await import('../src/auth/credentialStore.ts');
const { getOAuthAuthHeader, refreshIfNeeded } = await import('../src/auth/resolveOAuthAuth.ts');
const { refreshOAuthToken, RefreshFailedError, CannotRefreshError } = await import(
  '../src/auth/refreshOAuthToken.ts'
);
const { disconnectOAuth } = await import('../src/auth/disconnectOAuth.ts');
const { authedFetch } = await import('../src/auth/authedFetch.ts');
const { registerProvider, __resetRegistryForTests } = await import('../src/auth/providers.ts');
const { __resetDiscoveryCacheForTests } = await import('../src/auth/discovery.ts');
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

// ── Fake provider that supports refresh + revoke ─────────────────────────────

type RefreshSuccess = Record<string, unknown> & { access_token: string };
type RefreshFailure = { __status: number; __body?: string };
type RefreshQueueItem = RefreshSuccess | RefreshFailure;

interface FakeProviderState {
  baseUrl: string;
  refreshCallCount: number;
  refreshResponseQueue: RefreshQueueItem[];
  revokeCallCount: number;
  revokeStatus: number;
  resourceCalls: Array<{ authorization: string; status: number }>;
  resourceResponseQueue: Array<{ status: number; body?: string }>;
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

  app.post('/token', async (c) => {
    const body = new URLSearchParams(await c.req.text());
    if (body.get('grant_type') === 'refresh_token') {
      state.refreshCallCount++;
      const next = state.refreshResponseQueue.shift();
      if (next && '__status' in next) {
        const fail = next as RefreshFailure;
        return c.text(fail.__body ?? '', fail.__status as 400 | 401 | 403 | 500);
      }
      const success = (next as RefreshSuccess | undefined) ?? {
        access_token: 'fake-new-access',
        refresh_token: 'fake-new-refresh',
        expires_in: 3600,
        scope: 'read write',
        token_type: 'Bearer',
      };
      return c.json(success);
    }
    return c.text('unsupported grant_type in test fixture', 400);
  });

  app.post('/revoke', async (c) => {
    state.revokeCallCount++;
    return c.text('', state.revokeStatus as 200 | 500);
  });

  // A "resource" endpoint we can route authedFetch at to simulate a 401.
  app.get('/resource', (c) => {
    const auth = c.req.header('Authorization') ?? '';
    const next = state.resourceResponseQueue.shift() ?? { status: 200 };
    state.resourceCalls.push({ authorization: auth, status: next.status });
    return c.text(next.body ?? 'ok', next.status as 200 | 401 | 500);
  });

  return app;
}

interface RunningFake {
  url: string;
  state: FakeProviderState;
  close: () => Promise<void>;
}

async function startFakeProvider(): Promise<RunningFake> {
  const state: FakeProviderState = {
    baseUrl: '',
    refreshCallCount: 0,
    refreshResponseQueue: [],
    revokeCallCount: 0,
    revokeStatus: 200,
    resourceCalls: [],
    resourceResponseQueue: [],
  };
  const app = buildFakeProvider(state);
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

async function withFake(fn: (fake: RunningFake) => Promise<void>): Promise<void> {
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
    await cacheClient('fakeprov', { clientId: 'fake-client-id-123' });
    await fn(fake);
  } finally {
    await fake.close();
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

try {
  console.log('refreshOAuthToken + disconnect tests');

  await test('refresh within cushion -> no refresh call (token returned as-is)', async () => {
    await withFake(async (fake) => {
      await setCredential('alice', 'fakeprov', {
        kind: 'oauth',
        accessToken: 'still-good',
        refreshToken: 'r1',
        expiresAt: Math.floor(Date.now() / 1000) + 3600, // well outside cushion
      });
      const token = await refreshIfNeeded('alice', 'fakeprov');
      assert(token === 'still-good', `got: ${token}`);
      assert(fake.state.refreshCallCount === 0, 'no refresh should have been made');
    });
  });

  await test('expired token -> refresh called, new row persisted (rotated refresh)', async () => {
    await withFake(async (fake) => {
      await setCredential('alice', 'fakeprov', {
        kind: 'oauth',
        accessToken: 'stale',
        refreshToken: 'r-old',
        expiresAt: Math.floor(Date.now() / 1000) - 60, // already expired
      });
      const token = await refreshIfNeeded('alice', 'fakeprov');
      assert(token === 'fake-new-access', `got: ${token}`);
      assert(fake.state.refreshCallCount === 1, 'refresh should run exactly once');

      const cred = await getCredential('alice', 'fakeprov');
      assert(cred?.accessToken === 'fake-new-access', 'new access persisted');
      assert(cred?.refreshToken === 'fake-new-refresh', 'rotated refresh persisted');
      assert(cred?.expiresAt && cred.expiresAt > Math.floor(Date.now() / 1000), 'new expiry future');
    });
  });

  await test('provider keeps refresh token (no rotation) -> old refresh preserved', async () => {
    await withFake(async (fake) => {
      fake.state.refreshResponseQueue.push({
        access_token: 'fake-new-access-2',
        expires_in: 1800,
        token_type: 'Bearer',
        // intentionally no refresh_token in the response
      });
      await setCredential('bob', 'fakeprov', {
        kind: 'oauth',
        accessToken: 'stale-2',
        refreshToken: 'r-keep-me',
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      });
      await refreshIfNeeded('bob', 'fakeprov');
      const cred = await getCredential('bob', 'fakeprov');
      assert(cred?.accessToken === 'fake-new-access-2', 'access updated');
      assert(cred?.refreshToken === 'r-keep-me', 'refresh preserved (no rotation)');
    });
  });

  await test('refresh returns 401 -> row deleted, RefreshFailedError thrown', async () => {
    await withFake(async (fake) => {
      fake.state.refreshResponseQueue.push({ __status: 401, __body: '{"error":"invalid_grant"}' });
      await setCredential('charlie', 'fakeprov', {
        kind: 'oauth',
        accessToken: 'dead',
        refreshToken: 'dead-refresh',
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      });
      try {
        await refreshIfNeeded('charlie', 'fakeprov');
        throw new Error('expected throw');
      } catch (err) {
        assert(err instanceof RefreshFailedError, `wrong error type: ${(err as Error).name}`);
        assert((err as { statusCode?: number }).statusCode === 401, 'status preserved');
        assert((err as Error).message.includes('npm run connect'), 'has reconnect hint');
      }
      const cred = await getCredential('charlie', 'fakeprov');
      assert(cred === null, 'row was deleted');

      // Follow-up call surfaces MissingCredentialError now that the row is gone.
      try {
        await getOAuthAuthHeader('charlie', 'fakeprov');
        throw new Error('expected throw');
      } catch (err) {
        assert(err instanceof MissingCredentialError, 'follow-up should be MissingCredentialError');
      }
    });
  });

  await test('refresh returns 500 -> RefreshFailedError but row preserved (transient)', async () => {
    await withFake(async (fake) => {
      fake.state.refreshResponseQueue.push({ __status: 500, __body: 'oops' });
      await setCredential('diana', 'fakeprov', {
        kind: 'oauth',
        accessToken: 'still',
        refreshToken: 'still-r',
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      });
      try {
        await refreshIfNeeded('diana', 'fakeprov');
        throw new Error('expected throw');
      } catch (err) {
        assert(err instanceof RefreshFailedError, 'wrong type');
        assert((err as { statusCode?: number }).statusCode === 500, 'status preserved');
      }
      const cred = await getCredential('diana', 'fakeprov');
      assert(cred !== null, 'row preserved on 5xx (transient)');
      assert(cred?.refreshToken === 'still-r', 'refresh token still there');
    });
  });

  await test('no refresh_token on row -> CannotRefreshError', async () => {
    await withFake(async () => {
      await setCredential('elias', 'fakeprov', {
        kind: 'oauth',
        accessToken: 'apikey-like',
        expiresAt: Math.floor(Date.now() / 1000) - 60, // expired
      });
      try {
        await refreshOAuthToken('elias', 'fakeprov');
        throw new Error('expected throw');
      } catch (err) {
        assert(err instanceof CannotRefreshError, 'wrong type');
        assert((err as Error).message.includes('no refresh token'), 'mentions reason');
        assert((err as Error).message.includes('npm run connect'), 'has reconnect hint');
      }
    });
  });

  await test('authedFetch retry-on-401: 401 then 200 with rotated header', async () => {
    await withFake(async (fake) => {
      // Initial row, then queue: refresh responds with a new access; resource
      // 401s first, then 200s on retry.
      await setCredential('frank', 'fakeprov', {
        kind: 'oauth',
        accessToken: 'old-access',
        refreshToken: 'frank-refresh',
        expiresAt: Math.floor(Date.now() / 1000) + 3600, // valid, so getHeader uses old
      });
      fake.state.resourceResponseQueue.push({ status: 401 });
      fake.state.resourceResponseQueue.push({ status: 200 });

      const fetchHook = authedFetch({
        getHeader: () => getOAuthAuthHeader('frank', 'fakeprov'),
        refreshHeader: () => getOAuthAuthHeader('frank', 'fakeprov', { force: true }),
      });
      const res = await fetchHook(`${fake.url}/resource`, { method: 'GET' });
      assert(res.status === 200, `final status: ${res.status}`);
      assert(fake.state.resourceCalls.length === 2, 'exactly 2 resource calls (one retry)');
      assert(
        fake.state.resourceCalls[0]!.authorization === 'Bearer old-access',
        'first call used old token',
      );
      assert(
        fake.state.resourceCalls[1]!.authorization === 'Bearer fake-new-access',
        'retry used refreshed token',
      );
      assert(fake.state.refreshCallCount === 1, 'refresh was called exactly once');
    });
  });

  await test('authedFetch: 200 first -> no refresh, no retry', async () => {
    await withFake(async (fake) => {
      await setCredential('grace', 'fakeprov', {
        kind: 'oauth',
        accessToken: 'fresh-access',
        refreshToken: 'grace-refresh',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
      fake.state.resourceResponseQueue.push({ status: 200 });
      const fetchHook = authedFetch({
        getHeader: () => getOAuthAuthHeader('grace', 'fakeprov'),
        refreshHeader: () => getOAuthAuthHeader('grace', 'fakeprov', { force: true }),
      });
      const res = await fetchHook(`${fake.url}/resource`, { method: 'GET' });
      assert(res.status === 200, 'status 200');
      assert(fake.state.refreshCallCount === 0, 'no refresh on happy path');
      assert(fake.state.resourceCalls.length === 1, 'no retry');
    });
  });

  await test('disconnect: calls revoke + deletes row', async () => {
    await withFake(async (fake) => {
      await setCredential('hank', 'fakeprov', {
        kind: 'oauth',
        accessToken: 'tok',
        refreshToken: 'r',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
      const result = await disconnectOAuth('hank', 'fakeprov');
      assert(result.hadCredential, 'had credential');
      assert(result.deleted, 'deleted');
      assert(result.revokeAttempted, 'revoke was attempted');
      assert(result.revokeStatus === 200, 'revoke status');
      assert(fake.state.revokeCallCount === 1, 'revoke called once');
      assert((await getCredential('hank', 'fakeprov')) === null, 'row gone');
    });
  });

  await test('disconnect: deletes row even if revoke returns 500', async () => {
    await withFake(async (fake) => {
      fake.state.revokeStatus = 500;
      await setCredential('iris', 'fakeprov', {
        kind: 'oauth',
        accessToken: 'tok',
        refreshToken: 'r',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
      const result = await disconnectOAuth('iris', 'fakeprov');
      assert(result.deleted, 'still deletes locally on 5xx revoke');
      assert(result.revokeStatus === 500, 'reports 500');
      assert((await getCredential('iris', 'fakeprov')) === null, 'row gone');
    });
  });

  await test('disconnect: missing row -> no-op with friendly note', async () => {
    await withFake(async () => {
      // ensure no row
      await deleteCredential('nobody-here', 'fakeprov');
      const result = await disconnectOAuth('nobody-here', 'fakeprov');
      assert(!result.hadCredential, 'no credential');
      assert(!result.deleted, 'nothing to delete');
      assert(!result.revokeAttempted, 'no revoke');
      assert(result.notes.some((n) => n.includes('nothing to do')), 'friendly note');
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
