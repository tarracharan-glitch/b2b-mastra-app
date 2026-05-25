# my-mastra-app

Welcome to your new [Mastra](https://mastra.ai/) project! We're excited to see what you'll build.

## Getting Started

1. Put the three required env vars in `.env` (see **Environment**). The dev server refuses to boot if any are missing, and prints exactly what's wrong.
2. Add your Tavily key to the credential store (this is the only way — there is no env-var fallback):

   ```shell
   npm run set-credential -- --user default --provider tavily --kind api_key --token tvly-...
   ```

3. (Optional, for Notion) start the OAuth helper and run the connect flow:

   ```shell
   npm run oauth:serve                                          # terminal 1
   npm run connect -- --provider notion --user default          # terminal 2
   ```

4. Start the dev server:

   ```shell
   npm run dev
   ```

Open [http://localhost:4111](http://localhost:4111) for [Mastra Studio](https://mastra.ai/docs/studio/overview) — an interactive UI for building and testing agents plus a REST API at `/api`.

You can start editing files inside the `src/mastra` directory. The development server will automatically reload whenever you make changes.

## Environment

Required:

```
GOOGLE_GENERATIVE_AI_API_KEY=...     # model auth — https://aistudio.google.com/app/apikey
TOKEN_ENCRYPTION_KEY=...             # AES-256 key for auth.db rows
OAUTH_STATE_SECRET=...               # HMAC key for OAuth state JWTs; ≥32 chars
```

Optional:

```
OAUTH_REDIRECT_BASE_URL=...          # defaults to http://localhost:3000; override when proxying through ngrok
USER_ID=...                          # defaults to "default"; selects which row in auth.db the agent reads
```

Generate the two secrets once and reuse:

```shell
openssl rand -base64 32   # for TOKEN_ENCRYPTION_KEY
openssl rand -base64 48   # for OAUTH_STATE_SECRET
```

**Provider tokens never go in `.env`.** Tavily API keys live in the credential store (`npm run set-credential`); Notion (and any future OAuth provider) lives there too (`npm run connect`).

## Credential store

Provider secrets (Tavily today, OAuth tokens in later phases) live in a dedicated `auth.db` SQLite file (LibSQL), separate from `memory.db` so the auth surface is isolated. Rows are AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY` and bound by AAD `${userId}:${provider}`, so ciphertexts can't be replayed across users.

Manage credentials with the CLI:

```shell
# Add or overwrite a credential
npm run set-credential -- --user default --provider tavily --kind api_key --token tvly-...

# OAuth-style row (normally written by the OAuth callback; useful for tests)
npm run set-credential -- --user default --provider notion --kind oauth \
  --token ntn_access_... --refresh ntn_refresh_... --expires-in 3600 --scope "read write"

# Audit what's stored — tokens are never printed
npm run credentials                           # all users
npm run credentials -- --user default         # filter
```

The agent reads its credentials from the store at the moment it makes a request — rotating with `set-credential` takes effect on the next chat turn, no restart needed. `USER_ID` env var selects which row the agent uses.

Run all test suites:

```shell
npm run test:auth                   # encryption / AAD / missing key
npm run test:tavily-auth            # Tavily header resolver
npm run test:resolve-oauth          # OAuth resolver (no row, expired, tampered)
npm run test:oauth-flow             # /connect + /callback end-to-end
npm run test:refresh-disconnect     # refresh, retry-on-401, disconnect
```

## OAuth helper

A small Hono server at `http://localhost:3000` handles OAuth flows for any provider registered in `src/auth/providers.ts`. **Notion** is registered out of the box — others can be added by the same `registerProvider({...})` pattern.

```shell
# In one terminal: start the OAuth callback server (binds to 127.0.0.1)
npm run oauth:serve

# In another terminal: connect or disconnect a provider
npm run connect -- --provider notion [--user <userId>]
npm run disconnect -- --provider notion [--user <userId>]
```

`connect` opens the provider's consent screen in your default browser; on authorize, the callback writes an encrypted `kind=oauth` row to `auth.db`. `disconnect` POSTs to the provider's `revocation_endpoint` if it advertises one (best-effort — the local row is deleted either way) and removes the credential.

### Token lifecycle

- **Transparent refresh.** When the resolver sees a credential within 60s of its expiry it calls `refreshOAuthToken(userId, provider)` under the hood — the next chat turn just works, no restart needed.
- **Retry on 401.** Every MCP request is wrapped in `authedFetch`: if the server returns 401, the resolver force-refreshes once and retries. Useful when the provider invalidates a token earlier than the stated expiry.
- **Hard failures surface cleanly.** `RefreshFailedError` (4xx from the token endpoint → row deleted) and `CannotRefreshError` (no `refresh_token` to use) both carry `npm run connect -- --provider X --user Y` as the actionable hint.

## Admin UI

A server-rendered web page at `http://localhost:3000/admin` (served by the same Hono app as `/oauth`) lists every provider in `src/auth/providers.ts`, shows its connection state with an expiry countdown, and offers **Connect / Refresh / Disconnect** buttons. OAuth providers click straight through to the existing `/oauth/<p>/connect` flow (the callback redirects back to `/admin` instead of the standalone success page); API-key providers get an inline form. Forms are real `<form method="POST">` elements — no JavaScript required.

**Security note: do not expose.** The admin server binds to `127.0.0.1` and has no authentication — anyone who can reach the port can revoke your tokens. Don't proxy it through ngrok or open the port. Every form carries an HMAC-signed CSRF token bound to `(userId, formId, minute)`; tokens older than 10 minutes are rejected with a "session expired" page. Token material is never rendered into HTML.

### About `TOKEN_ENCRYPTION_KEY`

This single env var is the master key for every row in `auth.db`. **If you lose it, every stored credential is unrecoverable** — `getCredential` will throw `CredentialAuthError` because GCM authentication tags won't validate. There is no recovery path other than deleting `auth.db` and reconnecting every provider. Rotate it intentionally (re-encrypt all rows) or treat it as immutable per environment.

## Learn more

To learn more about Mastra, visit our [documentation](https://mastra.ai/docs/). Your bootstrapped project includes example code for [agents](https://mastra.ai/docs/agents/overview), [tools](https://mastra.ai/docs/agents/using-tools), [workflows](https://mastra.ai/docs/workflows/overview), [scorers](https://mastra.ai/docs/evals/overview), and [observability](https://mastra.ai/docs/observability/overview).

If you're new to AI agents, check out our [course](https://mastra.ai/learn) and [YouTube videos](https://youtube.com/@mastra-ai). You can also join our [Discord](https://discord.gg/BTYqqHKUrf) community to get help and share your projects.

## Deploy to the Mastra platform

The [Mastra platform](https://projects.mastra.ai) provides two products for deploying and managing AI applications built with the Mastra framework:

- **Studio**: A hosted visual environment for testing agents, running workflows, and inspecting traces
- **Server**: A production deployment target that runs your Mastra application as an API server

Learn more in the [Mastra platform documentation](https://mastra.ai/docs/mastra-platform/overview).