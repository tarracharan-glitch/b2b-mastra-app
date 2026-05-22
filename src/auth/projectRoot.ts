import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walk up from `startDir` until a `tsconfig.json` is found. Used to locate
 * the real project root regardless of whether we're running from the dev
 * bundle (`.mastra/output/`), the CLI (project root), or a test fixture.
 *
 * tsconfig.json is more reliable than package.json because the dev bundler
 * emits its own package.json inside .mastra/output/.
 */
export function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, 'tsconfig.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

export function defaultAuthDbUrl(callerImportMetaUrl: string): string {
  if (process.env.AUTH_DB_URL) return process.env.AUTH_DB_URL;
  const root = findProjectRoot(dirname(fileURLToPath(callerImportMetaUrl)));
  return `file:${join(root, 'auth.db')}`;
}
