# MCP server connections — implementation notes

This document records the micro-decisions and assumptions made while building the
MCP server connection feature on `/dashboard`, and calls out anything that could
not be fully verified. Screenshots of every state live in
[`docs/screenshots/`](./screenshots).

## What was built

Users can connect remote MCP (Model Context Protocol) servers from the
dashboard. The flow covers **connect** (URL validation → server probe → OAuth
discovery → dynamic client registration → PKCE authorization → encrypted token
storage), plus **test**, **edit**, **reconnect**, and **disconnect**. Free
accounts are limited to 3 servers, Pro accounts are unlimited (enforced
server-side through the existing billing entitlement system).

| Area                                                  | Location                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| DB schema (`mcp_server`, `mcp_auth_session`)          | `src/db/schema.ts`, `drizzle/0002_famous_la_nuit.sql`        |
| Token encryption (AES-256-GCM)                        | `src/lib/mcp/crypto.server.ts`                               |
| SSRF / URL validation + redirect-refusing fetch       | `src/lib/mcp/url-security.server.ts`                         |
| OAuth discovery, DCR, PKCE, token exchange, MCP probe | `src/lib/mcp/oauth.server.ts`                                |
| Domain logic (CRUD, limit, sessions, orchestration)   | `src/lib/mcp/servers.server.ts`                              |
| API routes                                            | `src/routes/api/mcp/`                                        |
| Dashboard UI                                          | `src/components/mcp/`, `src/routes/_protected/dashboard.tsx` |
| Tests (42)                                            | `src/lib/mcp/*.test.ts`                                      |

## Micro-decisions

### Architecture & data model

1. **Injectable `McpContext` instead of passing `env` everywhere.** Domain
   functions take `{ db, encryptionSecret, urlOptions, isUnlimited }` so tests
   run against an in-memory better-sqlite3 database with the _real_ generated
   migrations applied, while production wires D1 + the billing entitlement
   check. The SQL dialect is identical, so the raw guarded INSERT is exercised
   by tests unchanged.
2. **Limit enforcement is atomic.** Besides an early informative check, the
   insert itself is a guarded `INSERT … SELECT … WHERE (SELECT COUNT(*) …) < 3`
   in a single statement, so concurrent requests cannot overshoot the limit
   (D1 has no interactive transactions). Pro users take a plain insert path.
3. **Limit surfaced as a new entitlement.** `unlimited_mcp_servers` was added to
   the Pro plan in `BILLING_CATALOG` and checked via the existing
   `hasEntitlement()`; the free limit (`MCP_FREE_SERVER_LIMIT = 3`) lives in
   client-safe `src/lib/mcp/config.ts`. Existing billing controls were not
   modified beyond adding the entitlement string.
4. **One row per (user, URL).** A unique index on `(user_id, server_url)` maps
   duplicate connects to HTTP 409 with a machine-readable code.
5. **A server saved mid-OAuth stays in `needs_auth`.** If the user abandons the
   authorization page, the card shows "Needs authorization" with a Reconnect
   action — the pending row counts toward the free limit (deliberate: it
   reserves the slot and makes abandonment recoverable).
6. **OAuth state is a separate `mcp_auth_session` table** keyed by the `state`
   parameter (256-bit random), single-use, 10-minute TTL, bound to the user id
   (callback rejects a state minted for a different account → CSRF protection).
   Sessions cascade-delete with the server.
7. **`disconnect` = hard delete.** Row deletion destroys the encrypted tokens.
   Token revocation at the authorization server (RFC 7009) is not attempted —
   documented trade-off, most MCP auth servers don't expose it via metadata we
   fetch.
8. **Downgrade behavior:** a user who downgrades with >3 servers keeps them;
   the limit only gates _new_ connections. This mirrors common SaaS behavior
   and avoids destructive surprises.

### Security

9. **Encryption:** AES-256-GCM via WebCrypto, key from the
   `MCP_TOKEN_ENCRYPTION_KEY` environment secret (base64, 32 bytes,
   `openssl rand -base64 32`). Payload format `v1.<iv>.<ciphertext>` allows
   future key/format rotation. Encrypted: access/refresh tokens, OAuth client
   secret, and the PKCE verifier while a flow is pending. The key is never
   stored in the DB or source.
10. **What is _not_ encrypted:** server URL, discovered endpoint URLs, and the
    OAuth `client_id` (public identifiers, useful for debugging). The client
    _secret_ is encrypted.
11. **API responses are sanitized** through one `sanitizeServer()` function —
    `auth_data` and `oauth_config` never leave the server. A test asserts the
    serialized list contains no credential material.
12. **SSRF:** user URLs and _every_ discovered endpoint (metadata, authorize,
    token, registration) must pass `assertSafeExternalUrl`: HTTPS-only, no
    embedded credentials, blocklists for loopback/private/reserved IPv4 ranges
    (0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 192.0/24,
    198.18/15, ≥224/4), `localhost`/`.local`/`.internal`/`.home.arpa` suffixes,
    and cloud metadata hosts. IPv6 literals are rejected wholesale rather than
    range-checked (simpler and safer; use a hostname). WHATWG URL parsing
    normalises exotic IPv4 encodings (`https://2130706433` → `127.0.0.1`)
    before the check — covered by tests.
13. **Redirects are never followed.** All outbound requests use
    `redirect: "manual"` and treat 3xx as an error, so a vetted URL can't
    bounce a credentialed request to an arbitrary host. OAuth's own redirect
    (browser → authorization endpoint → our fixed callback path) is the only
    redirect in the flow, and the callback always redirects to the fixed
    same-origin `/dashboard` path.
14. **Dev escape hatch:** `MCP_ALLOW_INSECURE_LOCALHOST=true` permits
    plain-HTTP _loopback only_ (not private ranges — tested), for local MCP
    development. Off by default.
15. **Log hygiene:** thrown `ApiError`s bypass the generic `console.error` in
    `handleApiError`; token-endpoint failures surface only the OAuth error code
    plus a 200-char-truncated description; refresh failures are swallowed into
    a "reconnect" state without logging token material. Verified: no access
    tokens appeared in the dev-server logs during a full E2E run.
16. **Callback auth:** the OAuth callback requires a signed-in session; an
    expired session mid-flow redirects to `/sign-in` rather than erroring.
17. **Mutating routes require same-origin** (`sameOrigin: true`), matching the
    billing routes' CSRF posture. The callback GET cannot (top-level navigation
    has no Origin header) — its state binding provides the protection.

### OAuth / MCP protocol

18. **Spec order with legacy fallback:** probe with JSON-RPC `initialize`
    (Streamable HTTP, protocol `2025-06-18`) → on 401 parse `WWW-Authenticate`
    `resource_metadata` (RFC 9728) → protected-resource metadata → auth-server
    metadata (RFC 8414, with `openid-configuration` fallback) → dynamic client
    registration (RFC 7591, `token_endpoint_auth_method: "none"`) → PKCE S256 +
    `resource` indicator (RFC 8707) on both authorize and token requests. When
    no metadata is published, fall back to the 2024-11-05 spec's default
    endpoints (`/authorize`, `/token`, `/register` on the server origin).
19. **DCR is required for OAuth servers.** If registration isn't offered, the
    connect fails with a clear 502 message. Manual client-credential entry was
    deliberately cut from scope (would need more UI + storage paths); the error
    tells the user why.
20. **Token refresh happens lazily** during test/usage when the token is within
    30s of expiry; a failed refresh degrades to `needs_auth` (Reconnect), never
    an opaque error. The old refresh token is kept if the server doesn't rotate
    it.
21. **Reconnect reuses the registered client** (`client_id` + encrypted secret)
    and only re-runs discovery/DCR when no config is stored. Reconnect on a
    server that stopped requiring auth simply marks it connected again.
22. **Probe leniency:** a 200 response with an unparseable body still counts as
    reachable (`serverInfo` just stays empty); SSE responses are parsed from the
    first `data:` line. The probe sends `initialize` only — the
    `notifications/initialized` follow-up is intentionally skipped for a
    health check.
23. **`serverInfo` (name/version) from the handshake is stored** and shown on
    the card — cheap, useful feedback that the thing on the other end really is
    an MCP server.
24. **Chat integration hook:** `getServerRequestConfig(ctx, userId, serverId)`
    returns `{ url, headers }` with a fresh (auto-refreshed) bearer token for
    future chat features. There is no chat UI in this template yet, so this is
    the seam where it plugs in.

### API & UI

25. **Route param plumbing:** the shared `authenticatedApiHandler` in
    `src/lib/api.ts` was extended (backwards-compatibly) to pass TanStack
    Start's `params` through, instead of re-parsing URLs in each route.
26. **The test route is `/…/test-connection`,** not `/…/test`, so the route
    file doesn't match Vitest's `*.test.ts` glob.
27. **Callback results travel via query params**
    (`/dashboard?mcp=connected&mcpName=…`), validated by `validateSearch`, and
    render as a dismissible banner. `validateSearch` uses an explicit optional
    return type so existing `<Link to="/dashboard">` call sites don't break.
28. **UI uses TanStack Query** (already wired in the template's root provider)
    rather than the `useState`+`fetch` pattern of the older billing page —
    mutations invalidate one query key, keeping usage counts and the grid
    consistent.
29. **Micro-animations** use the template's existing `tw-animate-css` utilities
    only (no new deps): staggered card entrance, hover lift with a hard offset
    shadow (fits the radius-0 look), status-dot ping on connect / pulse while
    testing, a transient "Healthy" badge after a successful test, animated
    step transitions in the connect dialog, sliding error banners, and an
    animated usage meter.
30. **At-limit UX:** the Connect button stays enabled; the dialog switches to
    an upgrade panel linking to `/billing`. The server enforces regardless
    (verified live: the POST returns 403 + `mcp_server_limit_reached`).

## Assumptions

- **"Paying users" = active `pro_monthly` subscription**, the only paid plan in
  `BILLING_CATALOG`. Credit-pack purchases do not lift the server limit.
- **Remote MCP servers speak Streamable HTTP.** Legacy SSE-only servers
  (GET-based `/sse` transport) are out of scope and read as "responded with
  HTTP 4xx/405" on connect.
- **A 403 from the MCP endpoint is treated like 401** (auth required/rejected).
- **URL normalization is minimal:** `https://a/mcp` and `https://a/mcp/` count
  as different servers (WHATWG normalization only). Kept simple intentionally.
- The template's convention of raw `fetch` + `Response.json` API routes (no
  zod validation layer) was followed for consistency; input validation is
  manual but centralized in the domain layer.
- Screenshots were taken in the app's dark theme at 1440×900.

## Not fully verified / known limitations

- **DNS rebinding:** Workers cannot resolve DNS before fetching, so a public
  hostname resolving to a private IP cannot be detected at validation time.
  Mitigations: Cloudflare's egress network is outside your private network, and
  redirects are refused. Listed as residual risk.
- **No real-world OAuth provider was exercised.** The full flow (401 →
  discovery → DCR → PKCE → consent → callback → token exchange → authenticated
  probe → refresh → reconnect) was verified end-to-end against a local
  spec-conformant mock authorization server + MCP server, and against mocked
  responses in tests — but not against a production provider (e.g. GitHub's or
  Linear's MCP), which would require real accounts/tunnels. The discovery
  fallback chain follows the MCP authorization spec but provider quirks may
  surface.
- **Auth-server metadata path variants:** for issuers with path components the
  code tries `/.well-known/<suffix><path>` then `/.well-known/<suffix>`; the
  RFC 8414 _path-inserted_ form is covered, but the OIDC
  `<issuer-path>/.well-known/openid-configuration` suffix-form is not — legacy
  fallback catches most of these in practice.
- **Token revocation on disconnect** is not performed (see decision 7).
- **Response-size limits** on fetched metadata/probe bodies are not enforced
  beyond the 10s timeout.
- **D1's exact unique-constraint error text** in production is assumed to
  contain `UNIQUE constraint failed` somewhere in the error/cause chain (true
  for better-sqlite3 locally; the mapper walks the cause chain and falls back
  to rethrowing).
- `wrangler.jsonc` still has a placeholder D1 `database_id` (pre-existing);
  production deployment needs it plus `MCP_TOKEN_ENCRYPTION_KEY` set via
  `wrangler secret put`. **The migration `0002_famous_la_nuit.sql` has been
  applied to the local dev database only — production migration
  (`pnpm db:migrate:prod`) is left to the operator, per instructions.**

## Screenshot index

| File                          | State                                         |
| ----------------------------- | --------------------------------------------- |
| `01-empty-state.png`          | Empty grid, 0/3 usage meter                   |
| `02-connect-dialog.png`       | Connect form                                  |
| `03-authorize-step.png`       | OAuth required step in dialog                 |
| `04-oauth-consent.png`        | (Mock) authorization server consent page      |
| `05-connected-banner.png`     | Post-callback success banner + connected card |
| `06-test-healthy.png`         | Test action success                           |
| `07-grid-full.png`            | 3/3 grid: OAuth + open servers                |
| `08-limit-upgrade.png`        | Free-limit reached → upgrade panel            |
| `09-disconnect-confirm.png`   | Disconnect confirmation                       |
| `10-connect-error.png`        | Unreachable server error in dialog            |
| `11-edit-dialog.png`          | Edit name/URL dialog                          |
| `12-needs-auth-reconnect.png` | Rejected credentials → Reconnect state        |
| `13-reconnected.png`          | Reconnected after re-authorization            |
