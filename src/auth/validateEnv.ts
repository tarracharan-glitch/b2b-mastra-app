interface EnvSpec {
  name: string;
  description: string;
  /** Optional shell snippet that prints how to generate a valid value. */
  generateHint?: string;
  /** Optional validator beyond presence. Returns null if OK, else an error message. */
  validate?: (value: string) => string | null;
}

const REQUIRED: EnvSpec[] = [
  {
    name: 'GOOGLE_GENERATIVE_AI_API_KEY',
    description: 'Auth for the Gemini model used by b2bAgent.',
    generateHint: '# Get one at https://aistudio.google.com/app/apikey',
  },
  {
    name: 'TOKEN_ENCRYPTION_KEY',
    description: 'AES-256 key encrypting every row in auth.db.',
    generateHint: 'openssl rand -base64 32',
    validate: (value) => {
      const decoded = Buffer.from(value, 'base64');
      if (decoded.length < 32) return `must decode to >=32 bytes (got ${decoded.length})`;
      return null;
    },
  },
  {
    name: 'OAUTH_STATE_SECRET',
    description: 'HMAC key signing OAuth state JWTs.',
    generateHint: 'openssl rand -base64 48',
    validate: (value) => (value.length < 32 ? `must be >=32 characters (got ${value.length})` : null),
  },
];

/**
 * Verify every required env var is present and well-formed. Logs a single
 * combined report and exits with code 1 if anything is missing — the user
 * sees all problems at once instead of debugging them one by one.
 */
export function validateEnvOrExit(): void {
  const problems: Array<{ spec: EnvSpec; detail: string }> = [];

  for (const spec of REQUIRED) {
    const value = process.env[spec.name];
    if (!value || value.trim() === '') {
      problems.push({ spec, detail: 'missing' });
      continue;
    }
    if (spec.validate) {
      const err = spec.validate(value);
      if (err) problems.push({ spec, detail: err });
    }
  }

  if (problems.length === 0) return;

  console.error('[startup] required environment variables are missing or invalid:');
  for (const { spec, detail } of problems) {
    console.error(`  • ${spec.name} (${detail}) — ${spec.description}`);
    if (spec.generateHint) console.error(`      ${spec.generateHint}`);
  }
  console.error('');
  console.error('  Add these to .env and restart.');
  process.exit(1);
}
