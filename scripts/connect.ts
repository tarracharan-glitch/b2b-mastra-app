import open from 'open';

interface Args {
  provider?: string;
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
      'Usage: npm run connect -- --provider <name> [--user <userId>]\n' +
        'Example: npm run connect -- --provider notion --user default',
    );
    return process.exit(2);
  }
  const user = args.user ?? 'default';

  const base = process.env.OAUTH_REDIRECT_BASE_URL ?? 'http://localhost:3000';
  const url = `${base}/oauth/${encodeURIComponent(provider)}/connect?user=${encodeURIComponent(user)}`;

  console.log(`Opening ${url}`);
  console.log(`(Make sure 'npm run oauth:serve' is running in another terminal.)`);
  await open(url);
  console.log(`\nWaiting for the OAuth callback to land. Press Ctrl+C when done.`);
  await new Promise(() => undefined);
}

void main();
