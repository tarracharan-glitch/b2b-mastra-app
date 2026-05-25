import { createClient } from '@libsql/client';
import { defaultAuthDbUrl } from '../src/auth/projectRoot.ts';

interface Args {
  user?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2) as keyof Args;
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      throw new Error(`flag --${key} requires a value`);
    }
    out[key] = next;
    i++;
  }
  return out;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function fmtExpiry(epochSeconds: number | null): string {
  if (epochSeconds == null) return '—';
  const iso = new Date(epochSeconds * 1000).toISOString();
  const now = Math.floor(Date.now() / 1000);
  const delta = epochSeconds - now;
  if (delta < 0) return `${iso} (expired)`;
  if (delta < 3600) return `${iso} (${Math.floor(delta / 60)}m)`;
  if (delta < 86400) return `${iso} (${Math.floor(delta / 3600)}h)`;
  return `${iso} (${Math.floor(delta / 86400)}d)`;
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return process.exit(2);
  }

  const client = createClient({ url: defaultAuthDbUrl(import.meta.url) });
  await client
    .execute(
      `CREATE TABLE IF NOT EXISTS mcp_credentials (
         user_id TEXT, provider TEXT, kind TEXT,
         access_ciphertext TEXT, access_iv TEXT, access_tag TEXT,
         refresh_ciphertext TEXT, refresh_iv TEXT, refresh_tag TEXT,
         expires_at INTEGER, scope TEXT, metadata TEXT,
         created_at INTEGER, updated_at INTEGER,
         PRIMARY KEY (user_id, provider))`,
    )
    .catch(() => undefined);

  const where = args.user ? 'WHERE user_id = ?' : '';
  const sqlArgs = args.user ? [args.user] : [];
  const res = await client.execute({
    sql: `SELECT user_id, provider, kind, scope, expires_at, updated_at
          FROM mcp_credentials ${where}
          ORDER BY user_id, provider`,
    args: sqlArgs,
  });
  client.close();

  if (res.rows.length === 0) {
    console.log(
      args.user
        ? `(no credentials for user="${args.user}" — add with: npm run set-credential -- --user ${args.user} --provider <name> --kind api_key --token <token>)`
        : '(no credentials — add with npm run set-credential or npm run connect)',
    );
    return;
  }

  type Col = 'user' | 'provider' | 'kind' | 'scope' | 'expires_at' | 'updated_at';
  const headers: Record<Col, string> = {
    user: 'USER',
    provider: 'PROVIDER',
    kind: 'KIND',
    scope: 'SCOPE',
    expires_at: 'EXPIRES_AT',
    updated_at: 'UPDATED_AT',
  };
  const rows = res.rows.map((r) => ({
    user: String(r.user_id),
    provider: String(r.provider),
    kind: String(r.kind),
    scope: r.scope == null ? '—' : String(r.scope),
    expires_at: fmtExpiry(r.expires_at == null ? null : Number(r.expires_at)),
    updated_at: new Date(Number(r.updated_at) * 1000).toISOString(),
  }));

  const widths: Record<Col, number> = {
    user: Math.max(headers.user.length, ...rows.map((r) => r.user.length)),
    provider: Math.max(headers.provider.length, ...rows.map((r) => r.provider.length)),
    kind: Math.max(headers.kind.length, ...rows.map((r) => r.kind.length)),
    scope: Math.min(40, Math.max(headers.scope.length, ...rows.map((r) => r.scope.length))),
    expires_at: Math.max(headers.expires_at.length, ...rows.map((r) => r.expires_at.length)),
    updated_at: Math.max(headers.updated_at.length, ...rows.map((r) => r.updated_at.length)),
  };

  const cols: Col[] = ['user', 'provider', 'kind', 'scope', 'expires_at', 'updated_at'];
  const line = (cells: Record<Col, string>) =>
    cols.map((c) => pad(cells[c].slice(0, widths[c]), widths[c])).join('  ');

  console.log(line(headers));
  console.log(line(cols.reduce((acc, c) => ({ ...acc, [c]: '-'.repeat(widths[c]) }), {} as Record<Col, string>)));
  for (const r of rows) console.log(line(r));

  console.log('');
  console.log('(token material is never printed by this command)');
}

void main();
