# my-mastra-app

Welcome to your new [Mastra](https://mastra.ai/) project! We're excited to see what you'll build.

## Getting Started

1. Put model auth and the credential-store key in `.env` (see **Environment**).
2. Add your Tavily key to the credential store:

   ```shell
   npm run set-credential -- --user default --provider tavily --kind api_key --token tvly-...
   ```

3. Start the dev server:

   ```shell
   npm run dev
   ```

Open [http://localhost:4111](http://localhost:4111) for [Mastra Studio](https://mastra.ai/docs/studio/overview) — an interactive UI for building and testing agents plus a REST API at `/api`.

You can start editing files inside the `src/mastra` directory. The development server will automatically reload whenever you make changes.

## Environment

```
GOOGLE_GENERATIVE_AI_API_KEY=...     # model auth
TOKEN_ENCRYPTION_KEY=...             # AES-256 key for the credential store; required
OAUTH_STATE_SECRET=...               # HMAC key for the OAuth state JWT; ≥32 chars, required for OAuth flows
OAUTH_REDIRECT_BASE_URL=...          # (optional) defaults to http://localhost:3000; override when proxying through ngrok
TAVILY_API_KEY=...                   # (optional) one-time bootstrap — migrated into auth.db on first run, then ignored
USER_ID=...                          # (optional) defaults to "default"; selects which row in auth.db the agent reads
```

Generate the two secrets once and reuse — losing `TOKEN_ENCRYPTION_KEY` makes every stored credential unrecoverable:

```shell
openssl rand -base64 32   # for TOKEN_ENCRYPTION_KEY
openssl rand -base64 48   # for OAUTH_STATE_SECRET
```

## Credential store

Provider secrets (Tavily today, OAuth tokens in later phases) live in a dedicated `auth.db` SQLite file (LibSQL), separate from `memory.db` so the auth surface is isolated. Rows are AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY` and bound by AAD `${userId}:${provider}`, so ciphertexts can't be replayed across users.

Manage credentials with the CLI:

```shell
# Add or overwrite a credential
npm run set-credential -- --user default --provider tavily --kind api_key --token tvly-...

# OAuth-style row with refresh and expiry
npm run set-credential -- --user default --provider notion --kind oauth \
  --token ntn_access_... --refresh ntn_refresh_... --expires-in 3600 --scope "read write"
```

The agent reads its Tavily token from the store at the moment it makes a request — so rotating with `set-credential` takes effect on the next chat turn, no restart needed. `USER_ID` env var selects which row the agent uses.

Run the test suites with `npm run test:auth` (store), `npm run test:tavily-auth` (resolver), and `npm run test:oauth-flow` (OAuth helper end-to-end).

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