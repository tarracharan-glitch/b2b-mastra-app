import { disconnectOAuth } from '../src/auth/disconnectOAuth.ts';

interface Args {
  user?: string;
  provider?: string;
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

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return process.exit(2);
  }
  const provider = args.provider;
  if (!provider) {
    console.error(
      'Usage: npm run disconnect -- --provider <name> [--user <userId>]\n' +
        'Example: npm run disconnect -- --provider notion --user default',
    );
    return process.exit(2);
  }
  const user = args.user ?? 'default';

  const result = await disconnectOAuth(user, provider);

  for (const note of result.notes) {
    console.log(`[disconnect] ${note}`);
  }

  if (!result.hadCredential) {
    process.exit(0);
  }
  if (result.deleted) {
    console.log(`✓ disconnected ${provider} for user=${user}`);
    process.exit(0);
  }
  console.error(`✗ failed to delete credential`);
  process.exit(1);
}

void main();
