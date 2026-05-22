import { createClient, type Client } from '@libsql/client';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { defaultAuthDbUrl } from './projectRoot.ts';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const KEY_HINT =
  'TOKEN_ENCRYPTION_KEY must be a base64 string that decodes to at least 32 bytes. ' +
  'Generate one with:  openssl rand -base64 32';

export type CredentialKind = 'oauth' | 'api_key';

export interface CredentialInput {
  kind: CredentialKind;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch seconds
  scope?: string;
  metadata?: Record<string, unknown>;
}

export interface Credential extends CredentialInput {
  createdAt: number;
  updatedAt: number;
}

export interface CredentialStoreOptions {
  dbUrl: string;
  encryptionKey: Buffer;
}

export class MissingEncryptionKeyError extends Error {
  constructor(detail?: string) {
    super(detail ? `${KEY_HINT}\n  Detail: ${detail}` : KEY_HINT);
    this.name = 'MissingEncryptionKeyError';
  }
}

export class CredentialAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialAuthError';
  }
}

export class MissingCredentialError extends Error {
  readonly provider: string;
  readonly userId: string;
  constructor(provider: string, userId: string) {
    super(
      `No credential for provider="${provider}" user="${userId}". ` +
        `Run:  npm run set-credential -- --user ${userId} --provider ${provider} --kind api_key --token <token>`,
    );
    this.name = 'MissingCredentialError';
    this.provider = provider;
    this.userId = userId;
  }
}

interface CipherPayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

export class CredentialStore {
  private readonly client: Client;
  private readonly key: Buffer;
  private readonly schemaReady: Promise<void>;

  constructor(opts: CredentialStoreOptions) {
    if (opts.encryptionKey.length < KEY_LENGTH) {
      throw new MissingEncryptionKeyError(
        `key decoded to ${opts.encryptionKey.length} bytes, need >= ${KEY_LENGTH}`,
      );
    }
    this.key = opts.encryptionKey.subarray(0, KEY_LENGTH);
    this.client = createClient({ url: opts.dbUrl });
    this.schemaReady = this.initSchema();
  }

  private async initSchema(): Promise<void> {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS mcp_credentials (
        user_id              TEXT    NOT NULL,
        provider             TEXT    NOT NULL,
        kind                 TEXT    NOT NULL,
        access_ciphertext    TEXT    NOT NULL,
        access_iv            TEXT    NOT NULL,
        access_tag           TEXT    NOT NULL,
        refresh_ciphertext   TEXT,
        refresh_iv           TEXT,
        refresh_tag          TEXT,
        expires_at           INTEGER,
        scope                TEXT,
        metadata             TEXT,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        PRIMARY KEY (user_id, provider)
      )
    `);
  }

  private encrypt(plaintext: string, aad: string): CipherPayload {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    };
  }

  private decrypt(payload: CipherPayload, aad: string): string {
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(payload.iv, 'base64'));
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, 'base64')),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch (err) {
      throw new CredentialAuthError(
        `failed to decrypt credential (AAD mismatch, wrong key, or tampered row): ${(err as Error).message}`,
      );
    }
  }

  async getCredential(userId: string, provider: string): Promise<Credential | null> {
    await this.schemaReady;
    const aad = `${userId}:${provider}`;
    const result = await this.client.execute({
      sql: `SELECT kind, access_ciphertext, access_iv, access_tag,
                   refresh_ciphertext, refresh_iv, refresh_tag,
                   expires_at, scope, metadata, created_at, updated_at
            FROM mcp_credentials WHERE user_id = ? AND provider = ?`,
      args: [userId, provider],
    });
    if (result.rows.length === 0) return null;
    const row = result.rows[0]!;

    const accessToken = this.decrypt(
      {
        ciphertext: row.access_ciphertext as string,
        iv: row.access_iv as string,
        tag: row.access_tag as string,
      },
      aad,
    );

    let refreshToken: string | undefined;
    if (row.refresh_ciphertext != null) {
      refreshToken = this.decrypt(
        {
          ciphertext: row.refresh_ciphertext as string,
          iv: row.refresh_iv as string,
          tag: row.refresh_tag as string,
        },
        aad,
      );
    }

    return {
      kind: row.kind as CredentialKind,
      accessToken,
      refreshToken,
      expiresAt: row.expires_at == null ? undefined : Number(row.expires_at),
      scope: row.scope == null ? undefined : (row.scope as string),
      metadata: row.metadata == null ? undefined : JSON.parse(row.metadata as string),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async setCredential(userId: string, provider: string, input: CredentialInput): Promise<void> {
    await this.schemaReady;
    const aad = `${userId}:${provider}`;
    const access = this.encrypt(input.accessToken, aad);
    const refresh = input.refreshToken ? this.encrypt(input.refreshToken, aad) : null;
    const now = Math.floor(Date.now() / 1000);

    await this.client.execute({
      sql: `INSERT INTO mcp_credentials
              (user_id, provider, kind,
               access_ciphertext, access_iv, access_tag,
               refresh_ciphertext, refresh_iv, refresh_tag,
               expires_at, scope, metadata,
               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, provider) DO UPDATE SET
              kind = excluded.kind,
              access_ciphertext = excluded.access_ciphertext,
              access_iv = excluded.access_iv,
              access_tag = excluded.access_tag,
              refresh_ciphertext = excluded.refresh_ciphertext,
              refresh_iv = excluded.refresh_iv,
              refresh_tag = excluded.refresh_tag,
              expires_at = excluded.expires_at,
              scope = excluded.scope,
              metadata = excluded.metadata,
              updated_at = excluded.updated_at`,
      args: [
        userId,
        provider,
        input.kind,
        access.ciphertext,
        access.iv,
        access.tag,
        refresh?.ciphertext ?? null,
        refresh?.iv ?? null,
        refresh?.tag ?? null,
        input.expiresAt ?? null,
        input.scope ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now,
      ],
    });
  }

  async deleteCredential(userId: string, provider: string): Promise<void> {
    await this.schemaReady;
    await this.client.execute({
      sql: `DELETE FROM mcp_credentials WHERE user_id = ? AND provider = ?`,
      args: [userId, provider],
    });
  }

  async listProviders(userId: string): Promise<string[]> {
    await this.schemaReady;
    const result = await this.client.execute({
      sql: `SELECT provider FROM mcp_credentials WHERE user_id = ? ORDER BY provider`,
      args: [userId],
    });
    return result.rows.map((r) => r.provider as string);
  }

  async close(): Promise<void> {
    this.client.close();
  }
}

export function loadEncryptionKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw || raw.trim().length === 0) {
    throw new MissingEncryptionKeyError('environment variable is not set');
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, 'base64');
  } catch (err) {
    throw new MissingEncryptionKeyError(`not valid base64: ${(err as Error).message}`);
  }
  if (decoded.length < KEY_LENGTH) {
    throw new MissingEncryptionKeyError(
      `decoded to ${decoded.length} bytes, need >= ${KEY_LENGTH}`,
    );
  }
  return decoded;
}

let defaultStore: CredentialStore | null = null;

export function getDefaultCredentialStore(): CredentialStore {
  if (!defaultStore) {
    defaultStore = new CredentialStore({
      dbUrl: defaultAuthDbUrl(import.meta.url),
      encryptionKey: loadEncryptionKey(),
    });
  }
  return defaultStore;
}

export async function getCredential(userId: string, provider: string): Promise<Credential | null> {
  return getDefaultCredentialStore().getCredential(userId, provider);
}

export async function setCredential(
  userId: string,
  provider: string,
  input: CredentialInput,
): Promise<void> {
  return getDefaultCredentialStore().setCredential(userId, provider, input);
}

export async function deleteCredential(userId: string, provider: string): Promise<void> {
  return getDefaultCredentialStore().deleteCredential(userId, provider);
}

export async function listProviders(userId: string): Promise<string[]> {
  return getDefaultCredentialStore().listProviders(userId);
}

export async function bootstrapFromEnv(): Promise<void> {
  // Eagerly construct the store so a missing/invalid TOKEN_ENCRYPTION_KEY
  // fails at boot rather than on the first chat turn.
  const store = getDefaultCredentialStore();

  if (!process.env.TAVILY_API_KEY) return;
  const existing = await store.getCredential('default', 'tavily');
  if (existing) return;

  await store.setCredential('default', 'tavily', {
    kind: 'api_key',
    accessToken: process.env.TAVILY_API_KEY,
  });
  console.log('[auth] migrated TAVILY_API_KEY into credential store');
}
