import { serve } from '@hono/node-server';
import { createOAuthApp } from '../src/auth/oauthServer.ts';
import { signStateJwt } from '../src/auth/stateJwt.ts';

// Fail fast on missing env. signStateJwt() throws if OAUTH_STATE_SECRET is
// missing or too short, getDefaultCredentialStore() throws on missing
// TOKEN_ENCRYPTION_KEY (the credential store is touched at first /callback,
// but checking it eagerly here makes the failure mode obvious).
try {
  signStateJwt({ sub: 'startup-check', provider: 'startup-check' });
} catch (err) {
  console.error(`[oauth] startup failed: ${(err as Error).message}`);
  process.exit(1);
}

const port = Number(process.env.OAUTH_SERVER_PORT ?? 3000);
const hostname = '127.0.0.1';

const app = createOAuthApp();

serve(
  { fetch: app.fetch, port, hostname },
  (info) => {
    console.log(`[oauth] listening on http://${hostname}:${info.port}`);
    console.log(`[oauth] redirect base: ${process.env.OAUTH_REDIRECT_BASE_URL ?? `http://localhost:${info.port}`}`);
  },
);
