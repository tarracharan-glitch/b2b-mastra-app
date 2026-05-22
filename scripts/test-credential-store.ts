import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';

import {
  CredentialAuthError,
  CredentialStore,
  MissingEncryptionKeyError,
  loadEncryptionKey,
} from '../src/auth/credentialStore.ts';

type TestFn = () => Promise<void>;

let passed = 0;
let failed = 0;

async function test(name: string, fn: TestFn): Promise<void> {
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

function assertThrows<T>(fn: () => Promise<T>, predicate: (e: unknown) => boolean, msg: string): Promise<void> {
  return fn().then(
    () => {
      throw new Error(`expected to throw: ${msg}`);
    },
    (err) => {
      if (!predicate(err)) {
        throw new Error(`threw, but predicate did not match (${msg}): ${(err as Error).message}`);
      }
    },
  );
}

async function newStore(): Promise<{ store: CredentialStore; dir: string; dbPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'cred-store-test-'));
  const dbPath = join(dir, 'auth.db');
  const store = new CredentialStore({
    dbUrl: `file:${dbPath}`,
    encryptionKey: randomBytes(32),
  });
  return { store, dir, dbPath };
}

async function main(): Promise<void> {
  console.log('credentialStore tests');

  await test('roundtrip: setCredential then getCredential returns same plaintext', async () => {
    const { store, dir } = await newStore();
    try {
      await store.setCredential('alice', 'notion', {
        kind: 'oauth',
        accessToken: 'ntn_access_xyz',
        refreshToken: 'ntn_refresh_abc',
        expiresAt: 1_900_000_000,
        scope: 'read write',
        metadata: { workspaceId: 'ws-1' },
      });
      const got = await store.getCredential('alice', 'notion');
      assert(got !== null, 'expected non-null credential');
      assert(got.kind === 'oauth', 'kind');
      assert(got.accessToken === 'ntn_access_xyz', 'accessToken roundtrip');
      assert(got.refreshToken === 'ntn_refresh_abc', 'refreshToken roundtrip');
      assert(got.expiresAt === 1_900_000_000, 'expiresAt roundtrip');
      assert(got.scope === 'read write', 'scope roundtrip');
      assert(got.metadata?.workspaceId === 'ws-1', 'metadata roundtrip');

      const providers = await store.listProviders('alice');
      assert(providers.length === 1 && providers[0] === 'notion', 'listProviders');

      await store.deleteCredential('alice', 'notion');
      const afterDelete = await store.getCredential('alice', 'notion');
      assert(afterDelete === null, 'getCredential returns null after delete');
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('tamper: flipping a byte in access_ciphertext throws CredentialAuthError', async () => {
    const { store, dir, dbPath } = await newStore();
    try {
      await store.setCredential('alice', 'notion', {
        kind: 'oauth',
        accessToken: 'super-secret-token',
      });

      // Directly poke the DB to flip a byte in access_ciphertext.
      const raw = createClient({ url: `file:${dbPath}` });
      const before = await raw.execute({
        sql: 'SELECT access_ciphertext FROM mcp_credentials WHERE user_id = ? AND provider = ?',
        args: ['alice', 'notion'],
      });
      const ct = before.rows[0]!.access_ciphertext as string;
      const bytes = Buffer.from(ct, 'base64');
      bytes[0] = bytes[0]! ^ 0x01;
      await raw.execute({
        sql: 'UPDATE mcp_credentials SET access_ciphertext = ? WHERE user_id = ? AND provider = ?',
        args: [bytes.toString('base64'), 'alice', 'notion'],
      });
      raw.close();

      await assertThrows(
        () => store.getCredential('alice', 'notion'),
        (e) => e instanceof CredentialAuthError,
        'expected CredentialAuthError on tampered ciphertext',
      );
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('AAD mismatch: moving a row to a different user_id makes getCredential throw', async () => {
    const { store, dir, dbPath } = await newStore();
    try {
      await store.setCredential('alice', 'notion', {
        kind: 'oauth',
        accessToken: 'alice-only-token',
      });

      const raw = createClient({ url: `file:${dbPath}` });
      // Copy alice's row to bob (with bob's user_id) — AAD will be 'bob:notion'
      // on decrypt, but the ciphertext was bound to AAD 'alice:notion'.
      await raw.execute({
        sql: `INSERT INTO mcp_credentials
                (user_id, provider, kind,
                 access_ciphertext, access_iv, access_tag,
                 refresh_ciphertext, refresh_iv, refresh_tag,
                 expires_at, scope, metadata,
                 created_at, updated_at)
              SELECT 'bob', provider, kind,
                     access_ciphertext, access_iv, access_tag,
                     refresh_ciphertext, refresh_iv, refresh_tag,
                     expires_at, scope, metadata,
                     created_at, updated_at
              FROM mcp_credentials WHERE user_id = 'alice' AND provider = 'notion'`,
        args: [],
      });
      raw.close();

      await assertThrows(
        () => store.getCredential('bob', 'notion'),
        (e) => e instanceof CredentialAuthError,
        'expected CredentialAuthError on AAD mismatch',
      );

      // Alice's original row should still decrypt fine.
      const alice = await store.getCredential('alice', 'notion');
      assert(alice?.accessToken === 'alice-only-token', "alice's row still decrypts");
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('missing TOKEN_ENCRYPTION_KEY env var throws MissingEncryptionKeyError with clear message', async () => {
    const saved = process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    try {
      try {
        loadEncryptionKey();
        throw new Error('expected MissingEncryptionKeyError, got nothing');
      } catch (err) {
        assert(err instanceof MissingEncryptionKeyError, 'wrong error type');
        const msg = (err as Error).message;
        assert(msg.includes('openssl rand -base64 32'), 'message should include openssl one-liner');
        assert(msg.includes('TOKEN_ENCRYPTION_KEY'), 'message should name the env var');
      }

      // Too-short key path
      process.env.TOKEN_ENCRYPTION_KEY = Buffer.from('too-short').toString('base64');
      try {
        loadEncryptionKey();
        throw new Error('expected MissingEncryptionKeyError, got nothing');
      } catch (err) {
        assert(err instanceof MissingEncryptionKeyError, 'wrong error type for short key');
      }
    } finally {
      if (saved === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = saved;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
