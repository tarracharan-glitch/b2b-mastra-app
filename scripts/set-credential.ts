import { setCredential, type CredentialKind } from '../src/auth/credentialStore.ts';

interface Args {
  user?: string;
  provider?: string;
  kind?: string;
  token?: string;
  refresh?: string;
  'expires-in'?: string;
  scope?: string;
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

function usage(): string {
  return [
    'Usage:',
    '  npm run set-credential -- \\',
    '    --user <userId> --provider <name> --kind api_key|oauth --token <accessToken> \\',
    '    [--refresh <refreshToken>] [--expires-in <seconds>] [--scope "scope1 scope2"]',
    '',
    'Example:',
    '  npm run set-credential -- --user default --provider tavily --kind api_key --token tvly-...',
  ].join('\n');
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${(err as Error).message}\n\n${usage()}`);
    process.exit(2);
  }

  const { user, provider, kind, token } = args;
  if (!user || !provider || !kind || !token) {
    console.error(`error: --user, --provider, --kind, and --token are required\n\n${usage()}`);
    process.exit(2);
  }
  if (kind !== 'api_key' && kind !== 'oauth') {
    console.error(`error: --kind must be 'api_key' or 'oauth' (got '${kind}')`);
    process.exit(2);
  }

  let expiresAt: number | undefined;
  if (args['expires-in']) {
    const n = Number(args['expires-in']);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`error: --expires-in must be a positive number of seconds`);
      process.exit(2);
    }
    expiresAt = Math.floor(Date.now() / 1000) + n;
  }

  await setCredential(user, provider, {
    kind: kind as CredentialKind,
    accessToken: token,
    refreshToken: args.refresh,
    expiresAt,
    scope: args.scope,
  });

  const parts = [`user=${user}`, `provider=${provider}`, `kind=${kind}`];
  if (expiresAt) parts.push(`expires_at=${new Date(expiresAt * 1000).toISOString()}`);
  if (args.scope) parts.push(`scope="${args.scope}"`);
  console.log(`✓ stored credential (${parts.join(', ')})`);
}

void main();
