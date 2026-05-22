import { createClient, type Client } from '@libsql/client';
import { defaultAuthDbUrl } from './projectRoot.ts';

export interface OAuthClientRecord {
  clientId: string;
  clientSecret?: string;
  /** Full DCR response, JSON-stringified into the DB. */
  metadata?: Record<string, unknown>;
  createdAt: number;
}

let client: Client | null = null;
let schemaReady: Promise<void> | null = null;

function getClient(): Client {
  if (!client) {
    client = createClient({ url: defaultAuthDbUrl(import.meta.url) });
    schemaReady = client
      .execute(
        `CREATE TABLE IF NOT EXISTS oauth_clients (
           provider              TEXT PRIMARY KEY,
           client_id             TEXT NOT NULL,
           client_secret         TEXT,
           registration_metadata TEXT,
           created_at            INTEGER NOT NULL
         )`,
      )
      .then(() => undefined);
  }
  return client;
}

export async function getCachedClient(provider: string): Promise<OAuthClientRecord | null> {
  const c = getClient();
  await schemaReady;
  const res = await c.execute({
    sql: `SELECT client_id, client_secret, registration_metadata, created_at
          FROM oauth_clients WHERE provider = ?`,
    args: [provider],
  });
  if (res.rows.length === 0) return null;
  const row = res.rows[0]!;
  return {
    clientId: row.client_id as string,
    clientSecret: row.client_secret == null ? undefined : (row.client_secret as string),
    metadata:
      row.registration_metadata == null
        ? undefined
        : (JSON.parse(row.registration_metadata as string) as Record<string, unknown>),
    createdAt: Number(row.created_at),
  };
}

export async function cacheClient(
  provider: string,
  rec: Omit<OAuthClientRecord, 'createdAt'>,
): Promise<void> {
  const c = getClient();
  await schemaReady;
  await c.execute({
    sql: `INSERT INTO oauth_clients (provider, client_id, client_secret, registration_metadata, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(provider) DO UPDATE SET
            client_id = excluded.client_id,
            client_secret = excluded.client_secret,
            registration_metadata = excluded.registration_metadata`,
    args: [
      provider,
      rec.clientId,
      rec.clientSecret ?? null,
      rec.metadata ? JSON.stringify(rec.metadata) : null,
      Math.floor(Date.now() / 1000),
    ],
  });
}

export async function deleteCachedClient(provider: string): Promise<void> {
  const c = getClient();
  await schemaReady;
  await c.execute({ sql: `DELETE FROM oauth_clients WHERE provider = ?`, args: [provider] });
}
