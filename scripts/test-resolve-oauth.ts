import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'resolve-oauth-test-'));
process.env.AUTH_DB_URL = `file:${join(tempDir, 'auth.db')}`;
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');

const { setCredential, MissingCredentialError, CredentialAuthError } = await import(
  '../src/auth/credentialStore.ts'
);
const { getOAuthAuthHeader, ExpiredCredentialError } = await import('../src/auth/resolveOAuthAuth.ts');
const { createClient } = await import('@libsql/client');

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

try {
  console.log('resolveOAuthAuth tests');

  await test('valid OAuth row with future expiry -> Bearer header', async () => {
    await setCredential('alice', 'notion', {
      kind: 'oauth',
      accessToken: 'ntn-access-1',
      refreshToken: 'ntn-refresh-1',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      scope: 'read',
    });
    const header = await getOAuthAuthHeader('alice', 'notion');
    assert(header === 'Bearer ntn-access-1', `got: ${header}`);
  });

  await test('valid OAuth row with no expiry -> Bearer header (treated as long-lived)', async () => {
    await setCredential('alice2', 'notion', {
      kind: 'oauth',
      accessToken: 'ntn-access-noexp',
    });
    const header = await getOAuthAuthHeader('alice2', 'notion');
    assert(header === 'Bearer ntn-access-noexp', `got: ${header}`);
  });

  await test('no row -> MissingCredentialError with reconnect hint', async () => {
    try {
      await getOAuthAuthHeader('nobody', 'notion');
      throw new Error('expected throw');
    } catch (err) {
      assert(err instanceof MissingCredentialError, 'wrong error type');
      const msg = (err as Error).message;
      assert(msg.includes('notion'), 'mentions provider');
      assert(msg.includes('nobody'), 'mentions user');
      assert(msg.includes('npm run connect'), 'OAuth hint suggests connect, not set-credential');
    }
  });

  await test('tampered ciphertext -> clean CredentialAuthError (not a stack trace)', async () => {
    await setCredential('tamper', 'notion', {
      kind: 'oauth',
      accessToken: 'will-be-corrupted',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    // Flip a byte in access_ciphertext directly in the DB.
    const raw = createClient({ url: process.env.AUTH_DB_URL! });
    const before = await raw.execute({
      sql: 'SELECT access_ciphertext FROM mcp_credentials WHERE user_id=? AND provider=?',
      args: ['tamper', 'notion'],
    });
    const ct = before.rows[0]!.access_ciphertext as string;
    const bytes = Buffer.from(ct, 'base64');
    bytes[0] = bytes[0]! ^ 0x01;
    await raw.execute({
      sql: 'UPDATE mcp_credentials SET access_ciphertext=? WHERE user_id=? AND provider=?',
      args: [bytes.toString('base64'), 'tamper', 'notion'],
    });
    raw.close();

    try {
      await getOAuthAuthHeader('tamper', 'notion');
      throw new Error('expected throw');
    } catch (err) {
      assert(err instanceof CredentialAuthError, `wrong error type: ${(err as Error).name}`);
      const msg = (err as Error).message;
      assert(msg.includes('tampered') || msg.includes('AAD'), 'has a clean explanation');
    }
  });

  await test('expired row (past) -> ExpiredCredentialError', async () => {
    await setCredential('expiry-past', 'notion', {
      kind: 'oauth',
      accessToken: 'ntn-stale',
      expiresAt: Math.floor(Date.now() / 1000) - 100,
    });
    try {
      await getOAuthAuthHeader('expiry-past', 'notion');
      throw new Error('expected throw');
    } catch (err) {
      assert(err instanceof ExpiredCredentialError, `wrong error type: ${(err as Error).name}`);
      assert((err as Error).message.includes('npm run connect'), 'has reconnect hint');
    }
  });

  await test('expiring within cushion (next 60s) -> ExpiredCredentialError', async () => {
    await setCredential('expiry-soon', 'notion', {
      kind: 'oauth',
      accessToken: 'ntn-soon',
      expiresAt: Math.floor(Date.now() / 1000) + 30, // inside the 60s cushion
    });
    try {
      await getOAuthAuthHeader('expiry-soon', 'notion');
      throw new Error('expected throw');
    } catch (err) {
      assert(err instanceof ExpiredCredentialError, `wrong error type: ${(err as Error).name}`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
