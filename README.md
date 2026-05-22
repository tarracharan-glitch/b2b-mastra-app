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
TAVILY_API_KEY=...                   # (optional) one-time bootstrap — migrated into auth.db on first run, then ignored
USER_ID=...                          # (optional) defaults to "default"; selects which row in auth.db the agent reads
```

Generate `TOKEN_ENCRYPTION_KEY` once and reuse — losing it makes every stored credential unrecoverable:

```shell
openssl rand -base64 32
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

Run the test suites with `npm run test:auth` (store) and `npm run test:tavily-auth` (resolver).

## Learn more

To learn more about Mastra, visit our [documentation](https://mastra.ai/docs/). Your bootstrapped project includes example code for [agents](https://mastra.ai/docs/agents/overview), [tools](https://mastra.ai/docs/agents/using-tools), [workflows](https://mastra.ai/docs/workflows/overview), [scorers](https://mastra.ai/docs/evals/overview), and [observability](https://mastra.ai/docs/observability/overview).

If you're new to AI agents, check out our [course](https://mastra.ai/learn) and [YouTube videos](https://youtube.com/@mastra-ai). You can also join our [Discord](https://discord.gg/BTYqqHKUrf) community to get help and share your projects.

## Deploy to the Mastra platform

The [Mastra platform](https://projects.mastra.ai) provides two products for deploying and managing AI applications built with the Mastra framework:

- **Studio**: A hosted visual environment for testing agents, running workflows, and inspecting traces
- **Server**: A production deployment target that runs your Mastra application as an API server

Learn more in the [Mastra platform documentation](https://mastra.ai/docs/mastra-platform/overview).