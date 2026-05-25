import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Force the credentialStore singleton to use a per-test DB and key BEFORE
// the module is imported. The module reads these once at first access.
const tempDir = mkdtempSync(join(tmpdir(), 'tavily-auth-test-'));
process.env.AUTH_DB_URL = `file:${join(tempDir, 'auth.db')}`;
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');

const {
  setCredential,
  deleteCredential,
  MissingCredentialError,
} = await import('../src/auth/credentialStore.ts');
const { getTavilyAuthHeader } = await import('../src/auth/resolveTavilyAuth.ts');

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
  console.log('resolveTavilyAuth tests');

  await test('valid row -> returns Bearer <accessToken>', async () => {
    await setCredential('alice', 'tavily', {
      kind: 'api_key',
      accessToken: 'tvly-fixture-1',
    });
    const header = await getTavilyAuthHeader('alice');
    assert(header === 'Bearer tvly-fixture-1', `got: ${header}`);
  });

  await test('no row -> throws MissingCredentialError with actionable message', async () => {
    try {
      await getTavilyAuthHeader('bob');
      throw new Error('expected throw');
    } catch (err) {
      assert(err instanceof MissingCredentialError, 'wrong error type');
      const msg = (err as Error).message;
      assert(msg.includes('tavily'), 'should name the provider');
      assert(msg.includes('bob'), 'should name the user');
      assert(msg.includes('npm run set-credential'), 'should hint at the fix command');
    }
  });

  await test('mid-session replace -> next call returns new token (per-request resolution)', async () => {
    await setCredential('carol', 'tavily', {
      kind: 'api_key',
      accessToken: 'tvly-original',
    });
    const first = await getTavilyAuthHeader('carol');
    assert(first === 'Bearer tvly-original', `first: ${first}`);

    // Replace the row without restarting the process.
    await setCredential('carol', 'tavily', {
      kind: 'api_key',
      accessToken: 'tvly-rotated',
    });
    const second = await getTavilyAuthHeader('carol');
    assert(second === 'Bearer tvly-rotated', `second: ${second}`);

    // Delete -> next call throws.
    await deleteCredential('carol', 'tavily');
    try {
      await getTavilyAuthHeader('carol');
      throw new Error('expected throw after delete');
    } catch (err) {
      assert(err instanceof MissingCredentialError, 'wrong error type after delete');
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
