import { createClient } from '@libsql/client';
import { Hono, type Context } from 'hono';
import { mintCsrfToken, verifyCsrfToken } from './csrf.ts';
import { getCredential, setCredential } from './credentialStore.ts';
import { disconnectOAuth } from './disconnectOAuth.ts';
import { defaultAuthDbUrl } from './projectRoot.ts';
import { listProviders, providerKind, type MCPProvider } from './providers.ts';
import { refreshOAuthToken } from './refreshOAuthToken.ts';

const EXPIRY_OK_CUSHION_SEC = 60;
const EXPIRY_SOON_WINDOW_SEC = 5 * 60;

const FLASH_CODE_RE = /^(connected|disconnected|refreshed|error):(.+)$/s;

type CredState = 'none' | 'ok' | 'expiring' | 'expired';

interface ProviderRow {
  provider: MCPProvider;
  state: CredState;
  expiresAt?: number;
  scope?: string;
}

// ── HTML helpers ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

const STYLE = `
  body { font-family: system-ui, sans-serif; max-width: 50em; margin: 2em auto; padding: 0 1em; }
  header { display: flex; align-items: baseline; justify-content: space-between; }
  h1 { margin: 0; }
  .banner { background: #f4f4f4; border-left: 3px solid #888; padding: 0.6em 0.9em; margin: 1em 0; font-size: 0.92em; }
  table { border-collapse: collapse; width: 100%; margin-top: 1em; }
  th, td { text-align: left; padding: 0.5em 0.6em; border-bottom: 1px solid #eee; vertical-align: middle; }
  th { font-size: 0.8em; text-transform: uppercase; color: #555; }
  .badge { display: inline-block; padding: 0.1em 0.5em; border-radius: 0.4em; font-size: 0.85em; }
  .badge.ok { background: #d6f5d6; color: #064e06; }
  .badge.expiring { background: #fff2cc; color: #5b4302; }
  .badge.expired { background: #ffd6d6; color: #5b0202; }
  .badge.none { background: #eee; color: #444; }
  .actions form { display: inline; margin-right: 0.4em; }
  button { font: inherit; padding: 0.25em 0.7em; }
  .flash { padding: 0.6em 0.9em; margin: 1em 0; border-radius: 0.3em; }
  .flash.success { background: #d6f5d6; color: #064e06; }
  .flash.neutral { background: #eef; color: #234; }
  .flash.error   { background: #ffd6d6; color: #5b0202; }
  .meta { color: #777; font-size: 0.85em; }
  form.inline-key { margin: 1em 0; padding: 1em; background: #f8f8f8; border-radius: 0.4em; }
  label { display: block; margin-bottom: 0.6em; }
  input[type=text] { font: inherit; width: 100%; padding: 0.3em 0.4em; }
`;

function layout(body: string, opts: { title?: string } = {}): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(opts.title ?? 'MCP admin')}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

function renderFlash(rawFlash: string | undefined): string {
  if (!rawFlash) return '';
  const m = FLASH_CODE_RE.exec(rawFlash);
  if (!m) return '';
  const [, code, payload] = m as unknown as [string, string, string];
  const safe = escapeHtml(payload);
  switch (code) {
    case 'connected':
      return `<div class="flash success">✓ connected <strong>${safe}</strong></div>`;
    case 'disconnected':
      return `<div class="flash neutral">disconnected <strong>${safe}</strong></div>`;
    case 'refreshed':
      return `<div class="flash success">↻ refreshed <strong>${safe}</strong></div>`;
    case 'error':
      return `<div class="flash error">✗ ${safe}</div>`;
    default:
      return '';
  }
}

function fmtExpiry(epochSeconds: number | undefined): string {
  if (epochSeconds == null) return '—';
  const delta = epochSeconds - Math.floor(Date.now() / 1000);
  if (delta < 0) return `expired ${Math.floor(-delta / 60)}m ago`;
  if (delta < 3600) return `expires in ${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `expires in ${Math.floor(delta / 3600)}h`;
  return `expires in ${Math.floor(delta / 86400)}d`;
}

function badgeFor(state: CredState, expiresAt?: number): string {
  switch (state) {
    case 'ok':
      return `<span class="badge ok">✓ connected</span>`;
    case 'expiring':
      return `<span class="badge expiring">⏰ ${escapeHtml(fmtExpiry(expiresAt))}</span>`;
    case 'expired':
      return `<span class="badge expired">⚠ ${escapeHtml(fmtExpiry(expiresAt))}</span>`;
    case 'none':
      return `<span class="badge none">⚠ not connected</span>`;
  }
}

function actionsCell(row: ProviderRow, userId: string): string {
  const provider = row.provider;
  const name = provider.name;
  const kind = providerKind(provider);
  const escUser = escapeHtml(userId);
  const escName = escapeHtml(name);

  const connectButton = (label: string, formId: string) => {
    const csrf = escapeHtml(mintCsrfToken(userId, formId));
    return `<form method="POST" action="/admin/connect/${escName}">
      <input type="hidden" name="user" value="${escUser}">
      <input type="hidden" name="csrf" value="${csrf}">
      <button>${label}</button>
    </form>`;
  };

  const disconnectButton = () => {
    const csrf = escapeHtml(mintCsrfToken(userId, `disconnect:${name}`));
    return `<form method="POST" action="/admin/disconnect/${escName}">
      <input type="hidden" name="user" value="${escUser}">
      <input type="hidden" name="csrf" value="${csrf}">
      <button>Disconnect</button>
    </form>`;
  };

  const refreshButton = () => {
    const csrf = escapeHtml(mintCsrfToken(userId, `refresh:${name}`));
    return `<form method="POST" action="/admin/refresh/${escName}">
      <input type="hidden" name="user" value="${escUser}">
      <input type="hidden" name="csrf" value="${csrf}">
      <button>Refresh</button>
    </form>`;
  };

  if (row.state === 'none') {
    return connectButton(kind === 'api_key' ? 'Set API key' : 'Connect', `connect:${name}`);
  }
  // Has a row.
  const parts: string[] = [];
  if (kind === 'oauth' && row.state === 'ok') parts.push(refreshButton());
  if (kind === 'oauth' && (row.state === 'expiring' || row.state === 'expired')) {
    parts.push(refreshButton());
  }
  parts.push(disconnectButton());
  if (row.state === 'expired') parts.push(connectButton('Reconnect', `connect:${name}`));
  return parts.join('');
}

// ── State computation ──────────────────────────────────────────────────────

async function loadProviderRows(userId: string): Promise<ProviderRow[]> {
  const out: ProviderRow[] = [];
  for (const provider of listProviders()) {
    const cred = await getCredential(userId, provider.name);
    if (!cred) {
      out.push({ provider, state: 'none' });
      continue;
    }
    if (!cred.expiresAt) {
      out.push({ provider, state: 'ok', scope: cred.scope });
      continue;
    }
    const now = Math.floor(Date.now() / 1000);
    if (cred.expiresAt - EXPIRY_OK_CUSHION_SEC > now) {
      const state: CredState =
        cred.expiresAt - now < EXPIRY_SOON_WINDOW_SEC ? 'expiring' : 'ok';
      out.push({ provider, state, expiresAt: cred.expiresAt, scope: cred.scope });
    } else if (cred.expiresAt > now) {
      out.push({ provider, state: 'expiring', expiresAt: cred.expiresAt, scope: cred.scope });
    } else {
      out.push({ provider, state: 'expired', expiresAt: cred.expiresAt, scope: cred.scope });
    }
  }
  return out;
}

async function listDistinctUserIds(): Promise<string[]> {
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
  const res = await client.execute(
    `SELECT DISTINCT user_id FROM mcp_credentials ORDER BY user_id`,
  );
  client.close();
  return res.rows.map((r) => String(r.user_id));
}

// ── Routes ──────────────────────────────────────────────────────────────────

function readForm(c: Context): Promise<URLSearchParams> {
  return c.req
    .text()
    .then((t) => new URLSearchParams(t));
}

function badCsrf(c: Context) {
  return c.html(
    layout(
      `<h1>Session expired</h1><p>Your form token is invalid or older than 10 minutes. <a href="/admin">Reload the admin page</a> and try again.</p>`,
      { title: 'CSRF rejected' },
    ),
    403,
  );
}

export function mountAdminRoutes(app: Hono): void {
  app.get('/admin', async (c) => {
    const requestedUser = c.req.query('user');
    const defaultUser = process.env.USER_ID ?? 'default';
    const userId = requestedUser ?? defaultUser;
    const flash = c.req.query('flash');

    const [rows, distinctUsers] = await Promise.all([
      loadProviderRows(userId),
      listDistinctUserIds(),
    ]);

    const knownUsers = Array.from(new Set([...distinctUsers, userId, defaultUser])).sort();
    const userOptions = knownUsers
      .map(
        (u) =>
          `<option value="${escapeHtml(u)}"${u === userId ? ' selected' : ''}>${escapeHtml(u)}</option>`,
      )
      .join('');

    const rowsHtml =
      rows.length === 0
        ? `<tr><td colspan="4" class="meta">(no providers registered — add one in src/auth/providers.ts and restart)</td></tr>`
        : rows
            .map(
              (r) => `<tr>
                <td><strong>${escapeHtml(r.provider.name)}</strong></td>
                <td>${escapeHtml(providerKind(r.provider))}</td>
                <td>${badgeFor(r.state, r.expiresAt)}${r.scope ? `<div class="meta">${escapeHtml(r.scope)}</div>` : ''}</td>
                <td class="actions">${actionsCell(r, userId)}</td>
              </tr>`,
            )
            .join('');

    const switchUserCsrf = ''; // GET form, no CSRF needed
    const body = `
      <header>
        <h1>MCP providers</h1>
        <form method="GET" action="/admin">
          ${switchUserCsrf}
          <label>User: <select name="user" onchange="this.form.submit()">${userOptions}</select></label>
          <noscript><button>switch</button></noscript>
        </form>
      </header>
      <div class="banner">To register a new MCP provider, edit <code>src/auth/providers.ts</code> and restart <code>npm run dev</code>.</div>
      ${renderFlash(flash ?? undefined)}
      <table>
        <thead><tr><th>Provider</th><th>Kind</th><th>State</th><th>Actions</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <p class="meta">Loopback-only (127.0.0.1) — do not expose. Token material is never rendered.</p>
    `;
    return c.html(layout(body, { title: 'MCP admin' }));
  });

  // POST /admin/connect/:provider
  app.post('/admin/connect/:provider', async (c) => {
    const name = c.req.param('provider');
    const body = await readForm(c);
    const userId = body.get('user') ?? 'default';
    const csrf = body.get('csrf') ?? '';
    if (!verifyCsrfToken(csrf, userId, `connect:${name}`)) return badCsrf(c);

    const providers = listProviders();
    const provider = providers.find((p) => p.name === name);
    if (!provider) {
      const url = new URL(`/admin`, 'http://placeholder');
      url.searchParams.set('user', userId);
      url.searchParams.set('flash', `error:unknown provider "${name}"`);
      return c.redirect(`${url.pathname}?${url.searchParams.toString()}`, 303);
    }

    const kind = providerKind(provider);
    if (kind === 'oauth') {
      const u = new URL(`/oauth/${encodeURIComponent(name)}/connect`, 'http://placeholder');
      u.searchParams.set('user', userId);
      u.searchParams.set('from', 'admin');
      return c.redirect(`${u.pathname}?${u.searchParams.toString()}`, 303);
    }

    // api_key path — render inline form
    const formCsrf = escapeHtml(mintCsrfToken(userId, `credentials:${name}`));
    const escUser = escapeHtml(userId);
    const escName = escapeHtml(name);
    const formHtml = `
      <h1>Set API key for <code>${escName}</code></h1>
      <p class="meta">Token material is stored encrypted in <code>auth.db</code> and never rendered back to the page.</p>
      <form method="POST" action="/admin/credentials/${escName}" class="inline-key">
        <input type="hidden" name="user" value="${escUser}">
        <input type="hidden" name="csrf" value="${formCsrf}">
        <label>API key
          <input type="text" name="token" required autofocus autocomplete="off">
        </label>
        <label>Scope (optional)
          <input type="text" name="scope">
        </label>
        <button>Save</button>
        <a href="/admin?user=${encodeURIComponent(userId)}">cancel</a>
      </form>
    `;
    return c.html(layout(formHtml, { title: `Set ${name} API key` }));
  });

  // POST /admin/credentials/:provider
  app.post('/admin/credentials/:provider', async (c) => {
    const name = c.req.param('provider');
    const body = await readForm(c);
    const userId = body.get('user') ?? 'default';
    const csrf = body.get('csrf') ?? '';
    if (!verifyCsrfToken(csrf, userId, `credentials:${name}`)) return badCsrf(c);

    const providers = listProviders();
    const provider = providers.find((p) => p.name === name);
    if (!provider) {
      return c.redirect(`/admin?user=${encodeURIComponent(userId)}&flash=error:unknown%20provider`, 303);
    }
    const token = body.get('token') ?? '';
    if (!token) {
      return c.redirect(
        `/admin?user=${encodeURIComponent(userId)}&flash=error:token%20is%20required`,
        303,
      );
    }
    const refreshToken = body.get('refreshToken') || undefined;
    const expiresAtRaw = body.get('expiresAt');
    const scope = body.get('scope') || undefined;
    const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : undefined;

    await setCredential(userId, name, {
      kind: providerKind(provider),
      accessToken: token,
      refreshToken,
      expiresAt,
      scope,
    });
    return c.redirect(
      `/admin?user=${encodeURIComponent(userId)}&flash=connected:${encodeURIComponent(name)}`,
      303,
    );
  });

  // POST /admin/disconnect/:provider
  app.post('/admin/disconnect/:provider', async (c) => {
    const name = c.req.param('provider');
    const body = await readForm(c);
    const userId = body.get('user') ?? 'default';
    const csrf = body.get('csrf') ?? '';
    if (!verifyCsrfToken(csrf, userId, `disconnect:${name}`)) return badCsrf(c);

    try {
      await disconnectOAuth(userId, name);
      return c.redirect(
        `/admin?user=${encodeURIComponent(userId)}&flash=disconnected:${encodeURIComponent(name)}`,
        303,
      );
    } catch (err) {
      const msg = encodeURIComponent((err as Error).message);
      return c.redirect(`/admin?user=${encodeURIComponent(userId)}&flash=error:${msg}`, 303);
    }
  });

  // POST /admin/refresh/:provider
  app.post('/admin/refresh/:provider', async (c) => {
    const name = c.req.param('provider');
    const body = await readForm(c);
    const userId = body.get('user') ?? 'default';
    const csrf = body.get('csrf') ?? '';
    if (!verifyCsrfToken(csrf, userId, `refresh:${name}`)) return badCsrf(c);

    try {
      await refreshOAuthToken(userId, name);
      return c.redirect(
        `/admin?user=${encodeURIComponent(userId)}&flash=refreshed:${encodeURIComponent(name)}`,
        303,
      );
    } catch (err) {
      const msg = encodeURIComponent((err as Error).message);
      return c.redirect(`/admin?user=${encodeURIComponent(userId)}&flash=error:${msg}`, 303);
    }
  });
}
