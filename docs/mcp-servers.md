# MCP Server Connections

Users can connect [Model Context Protocol](https://modelcontextprotocol.io) servers to their
account from the dashboard (`/dashboard`). Free-plan users can connect up to **3** servers;
users on the Pro plan (`pro_monthly`) can connect an **unlimited** number. Credentials are
encrypted at rest with AES-256-GCM.

## Architecture

```
src/
├── db/schema.ts                  # mcp_server + mcp_oauth_transaction tables (migration 0002)
├── lib/mcp/
│   ├── config.server.ts          # McpEnv, limits, TTLs, timeouts
│   ├── crypto.server.ts          # AES-256-GCM encrypt/decrypt (WebCrypto)
│   ├── url.server.ts             # SSRF protection, DNS-over-HTTPS check, log sanitizer
│   ├── client.server.ts          # MCP JSON-RPC client + OAuth discovery/DCR/PKCE/token calls
│   ├── core.server.ts            # Domain logic (connect, callback, test, edit, reconnect, delete)
│   ├── testing/test-db.ts        # better-sqlite3 → D1 shim for unit tests
│   └── *.test.ts                 # 74 tests (crypto, SSRF, domain, limits, authz)
├── routes/api/mcp/
│   ├── servers/index.ts          # GET list (+quota), POST start connection
│   ├── servers/$serverId/index.ts    # PATCH edit, DELETE disconnect
│   ├── servers/$serverId/test.ts     # POST test connection
│   ├── servers/$serverId/reconnect.ts# POST reconnect
│   └── oauth/callback.ts         # GET OAuth redirect target → 302 to /dashboard
└── components/mcp/
    ├── mcp-servers-section.tsx   # Dashboard section: quota header, grid, banners
    ├── server-card.tsx           # Status badge, metadata, actions, inline feedback
    ├── add-server-dialog.tsx     # Multi-step connect wizard
    ├── edit-server-dialog.tsx    # Rename / change URL
    └── disconnect-server-dialog.tsx
```

### Connection flow

1. **Details** — user enters a display name and the server URL.
2. **Validation + probe** — the server validates the URL (format, https-only, no credentials,
   no private/reserved IPs or internal hostnames), resolves the hostname via DNS-over-HTTPS
   and rejects names resolving to non-public addresses, then performs the MCP `initialize`
   handshake (10 s timeout, redirects never followed).
3. **No auth required** → the server row is inserted (`status: connected`, `authType: none`)
   and the card appears in the grid.
4. **OAuth required** (401 from `initialize`) → discovery per RFC 9728
   (`WWW-Authenticate` `resource_metadata` or `/.well-known/oauth-protected-resource`) and
   RFC 8414 (`/.well-known/oauth-authorization-server`, with OIDC-style fallbacks), dynamic
   client registration (RFC 7591), and a PKCE (S256) transaction stored encrypted for 10
   minutes. The user is redirected to the authorization server.
5. **Callback** (`/api/mcp/oauth/callback`) — the one-time transaction is consumed, the code
   is exchanged, tokens are encrypted and stored, and the browser is 302-redirected to
   `/dashboard?mcp=connected` (or `?mcp=error&message=…` with a sanitized message).
6. **Test / Reconnect / Edit / Disconnect** are available per card. Test refreshes expired
   tokens transparently; a rejected token flips the card to `requires_auth` with a Reconnect
   CTA. Changing the URL clears stored credentials.

### Plan limit enforcement

- Enforced **server-side** in `insertServerWithLimit` via a conditional
  `INSERT … SELECT … WHERE (SELECT count(*) …) < limit`, so concurrent requests cannot
  overshoot the free limit. Pro plan is detected through the existing billing system
  (`getBillingSummary` + the `unlimited_mcp_servers` entitlement in
  `src/lib/billing/config.ts`).
- The limit is re-checked when the OAuth callback completes (the user may have hit the
  limit while authorizing).
- Reconnecting, testing, editing or deleting an existing server never consumes quota.

## Configuration

```bash
# Generate a 32-byte key and set it as an environment secret (never in the DB or code):
openssl rand -base64 32
pnpm exec wrangler secret put MCP_ENCRYPTION_KEY   # production
# .env.local for development:
MCP_ENCRYPTION_KEY=<base64-encoded 32 bytes>
```

Apply the database migration (not run automatically):

```bash
pnpm run db:migrate        # local
pnpm run db:migrate:prod   # production
```

## Micro-decisions and assumptions

1. **Schema/migration predated this change** — the `mcp_server` and `mcp_oauth_transaction`
   tables and migration `0002_powerful_korath` already existed (uncommitted) on this branch;
   the implementation builds on them as-is.
2. **Entitlement name** — `unlimited_mcp_servers` was added to the Pro plan's entitlements
   in `BILLING_CATALOG`; the existing `hasEntitlement`/`getBillingSummary` path is the only
   mechanism used for the plan check. Free plan limit (3) lives in
   `src/lib/mcp/config.server.ts`.
3. **Downgrade behavior** — a Pro user who downgrades keeps existing servers; the limit only
   blocks _new_ connections. Nothing is deleted automatically.
4. **HTTPS only** — plaintext `http://` MCP endpoints are rejected, even for public hosts,
   because bearer tokens would otherwise cross the wire unencrypted.
5. **No localhost/private servers** — developer MCP servers on `localhost`/RFC-1918 ranges
   are rejected to keep SSRF protection simple and strict. This is a deliberate product
   trade-off (cloud metadata endpoints like `169.254.169.254` must stay unreachable).
6. **DNS-over-HTTPS pre-check** — hostnames are resolved via `cloudflare-dns.com` before
   connecting and rejected if any answer is non-public. Residual TOCTOU/DNS-rebinding risk
   remains (see _Not fully verified_ below).
7. **Redirects are never followed** on outbound MCP/OAuth calls (`redirect: "manual"`),
   preventing credential leakage to third-party origins via redirect chains.
8. **Full-page redirect for OAuth** (not a popup) — consistent with the existing Stripe
   checkout pattern in this codebase, avoids popup blockers, and keeps the flow
   mobile-friendly. The dashboard surfaces the result via `?mcp=` search params, shows a
   banner, and scrubs the URL.
9. **State = transaction id** — the OAuth `state` is the unguessable transaction id; the
   transaction row is bound to the initiating user and is **deleted before the token
   exchange** to make callback URLs single-use. Transactions expire after 10 minutes.
10. **Dynamic client registration required** — servers whose authorization server does not
    expose an RFC 7591 `registration_endpoint` cannot be connected (clear 400 error). Manual
    client-id configuration is a possible future addition.
11. **Encryption format** — `v1.<base64url(iv)>.<base64url(ct+tag)>`, random 96-bit IV per
    write, WebCrypto AES-256-GCM. The version prefix allows future key/algorithm rotation.
    The key is imported per operation (no process-level caching) so a wrong/rotated key
    fails fast.
12. **Client secrets are supported but not required** — if the AS issues a `client_secret`
    during registration it is stored inside the encrypted bundle and used on refresh.
13. **Token refresh** — `testServer` refreshes when the token expires within a 60 s skew
    window; rotated refresh tokens are persisted (re-encrypted). A failed refresh marks the
    server `requires_auth`.
14. **No-auth servers** — a server that answers `initialize` without a 401 is stored with
    `authType: none`. Reconnecting such a server re-probes and clears any stale credentials.
15. **Editing the URL clears credentials** — tokens are resource-bound, so a URL change
    resets the row to `requires_auth` (with an explanatory `lastError`), and the UI warns
    before saving.
16. **Duplicate URLs** — normalized (trailing slashes trimmed) and unique per user; a second
    connect attempt returns 409 and suggests edit/reconnect instead. Completing an OAuth
    flow for an already-existing URL _updates_ the row rather than erroring.
17. **`lastError` hygiene** — only sanitized, truncated (200 chars) messages are stored;
    query strings and token-shaped strings (`[A-Za-z0-9_-]{24,}`) are stripped/redacted.
    Unexpected callback failures log only the error class name, never the URL or payload.
18. **API shape** — mutations require `sameOrigin` (CSRF) like the billing endpoints;
    errors use the existing `ApiError` → `{ error, ...details }` JSON convention; DTOs never
    contain `encryptedAuth` (test-verified).
19. **MCP protocol version** — the client pins `2025-06-18` and sends the
    `mcp-protocol-version` header; both plain-JSON and `text/event-stream` responses are
    parsed (first `message` event wins).
20. **UI patterns** — the section follows the billing page conventions (mono section
    labels, card grids, badge/error box styles, sharp radius). Micro-animations use the
    already-included `tw-animate-css` utilities: staggered card entrances, pulsing status
    dot, checklist step transitions, success pop, quota bar transition, disconnect
    fade/zoom-out, and dialog spinner states.
21. **Tests** — unit tests run in plain Node (no miniflare): a small better-sqlite3 shim
    emulates the D1 surface drizzle uses, and the real migrations from `drizzle/` are
    applied to an in-memory database. Network is stubbed at `fetch`.
22. **`src/lib/api.ts` extension** — the shared API handler now forwards route `params`
    (previously only `request`), which the `$serverId` routes need. Existing routes are
    unaffected.

## Verified manually (local dev, real services)

- Full OAuth discovery against the **production Linear MCP server** (`https://mcp.linear.app/mcp`):
  401 challenge → RFC 9728 metadata → RFC 8414 AS metadata → RFC 7591 dynamic client
  registration (a real `client_id` was issued) → correct authorization URL with PKCE S256 —
  landing on Linear's `/authorize` page. Token exchange + callback completion were _not_
  exercised (requires a real Linear account).
- SSRF rejection in the UI (`https://169.254.169.254/latest` → "The server URL must point to
  a public host"), duplicate-URL rejection (409), rename (PATCH), disconnect (DELETE) with
  grid/quota updates, and the callback error path
  (`/api/mcp/oauth/callback?code=fake&state=…` → 302 → dashboard error banner + URL scrub).

## Not fully verified / known limitations

- **Token exchange against a production AS** — implemented per RFC 6749/7636 and covered by
  mocked tests, but the live code-exchange/refresh round-trip needs a real account on an
  MCP OAuth provider. Edge cases (scope negotiation, `resource` indicators per RFC 8707)
  may need follow-up per provider.
- **DNS rebinding (TOCTOU)** — validation and the actual connection are separate fetches, so
  a malicious hostname could re-resolve to a private address in between. Cloudflare Workers
  does not offer connect-by-IP; the DoH pre-check plus literal-IP blocking is the strongest
  portable mitigation. A future hardening option is routing MCP traffic through an egress
  proxy with its own allow-list.
- **Chat integration** — persistence and `getValidAccessToken` prepare everything chat
  sessions need, but the template has no chat UI yet; wiring MCP tools into a model's
  toolset is intentionally out of scope.
- **SSE session management** — the Streamable HTTP transport's long-lived SSE channel and
  `mcp-session-id` resumption are not used; `initialize`/`tools/list` are stateless calls,
  which is sufficient for connect/test but not for tool invocation.
- **Cosmetic progress steps** — the wizard's intermediate "discovering" steps animate while
  one request is in flight; the outcome always comes from the server response.
- **`worker-configuration.d.ts`** — `MCP_ENCRYPTION_KEY` is deliberately _not_ added to
  generated types (secrets are not in `wrangler.jsonc`); it is declared via the `McpEnv`
  interface, mirroring how Stripe secrets are handled (`BillingEnv`).

## Screenshots

| State                                      | File                                             |
| ------------------------------------------ | ------------------------------------------------ |
| Empty dashboard section                    | `docs/screenshots/mcp-dashboard-empty.png`       |
| Grid with all server states + limit banner | `docs/screenshots/mcp-dashboard-grid.png`        |
| Connect wizard (form)                      | `docs/screenshots/mcp-add-server-dialog.png`     |
| SSRF error state                           | `docs/screenshots/mcp-add-server-error.png`      |
| OAuth authorization required               | `docs/screenshots/mcp-oauth-authorize.png`       |
| Real Linear `/authorize` redirect          | `docs/screenshots/mcp-linear-authorize-page.png` |
| Edit dialog                                | `docs/screenshots/mcp-edit-dialog.png`           |
| Disconnect confirmation                    | `docs/screenshots/mcp-disconnect-dialog.png`     |
| OAuth callback error banner                | `docs/screenshots/mcp-callback-error-banner.png` |
