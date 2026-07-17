# MCP Server Connection Feature — Decisions, Assumptions & Verification Notes

This document records the micro-decisions and assumptions made while implementing the
"Connect MCP servers" feature on `/dashboard`, plus things that could not be fully
verified in this environment. It is intended to aid review and future maintenance.

## Scope of the feature

Users can connect Model Context Protocol (MCP) servers to their account from the
dashboard. The flow is: configure a server URL → OAuth discovery → authenticate with
the MCP server → encrypted credentials are persisted → the server can be tested,
edited, reconnected, disconnected, or removed. Free users can connect at most 3
servers; Pro users (via the existing `unlimited_mcp_servers` entitlement) have no
limit. Configured servers are shown in a grid.

## Micro-decisions & assumptions

### Entitlements & limits

- **Reuse the existing billing/entitlement system.** The Pro plan gains a new
  entitlement `unlimited_mcp_servers` (added to `BILLING_CATALOG.subscriptionPlans.pro_monthly.entitlements`
  in `src/lib/billing/config.ts`). `hasEntitlement` is the only billing surface used.
- **Free limit = 3, enforced server-side** in `assertWithinMcpLimit`
  (`src/lib/mcp/core.server.ts`). The count is taken from D1, not from the client, and
  the limit is checked before inserting a new row. A violation throws `ApiError(402)`.
- **Limit counts all rows for the user regardless of status.** A `pending` or
  `disconnected` server still occupies a "slot" because it is configured. Users reclaim
  a slot by removing the server (DELETE). This prevents a free user from bypassing the
  limit by creating many pending rows. Assumed acceptable; alternative (count only
  `connected`) was rejected because it invites abuse.
- **Limit re-checked on creation, not on edit.** Editing a server's URL changes the
  `(user_id, url)` unique key but does not create a new row, so it does not consume an
  additional slot.

### Encryption & secrets

- **AES-GCM via Web Crypto** (`src/lib/mcp/crypto.server.ts`). A random 12-byte IV is
  prepended to the ciphertext and base64url-encoded. Authenticated encryption means
  tampered/incorrect-key blobs fail to decrypt.
- **Encryption key is an environment secret**, `MCP_ENCRYPTION_KEY` (32 bytes,
  base64-encoded). Provisioned via `wrangler secret put`, never in the DB or source.
  `.env.example` documents how to generate it. The key is validated at use time and
  surfaces as HTTP 500 if missing/malformed (never a plaintext secret in the response).
- **Two encrypted columns:** `encrypted_auth` (OAuth token response) and
  `oauth_pending` (in-flight PKCE verifier + state). Both are `TEXT`, encrypted at rest.
- **Tokens are never sent to the client.** `strip()` projects every row into a
  `SafeMcpServer` that intentionally omits `encryptedAuth` and `oauthPending`.
  `listMcpServers`/`getSafeMcpServer` only ever return the safe projection. A test
  asserts the plaintext token does not appear in the serialized server.

### OAuth flow (PKCE + discovery)

- **Discovery** follows the OAuth 2.0 Authorization Server Metadata convention
  (`/.well-known/oauth-authorization-server`), trying the resource-scoped variant first
  then the bare one, per the MCP spec direction. Discovery uses `redirect: "error"` so
  the server cannot redirect discovery requests.
- **`404` is treated as "no metadata" (non-fatal).** A server without published
  metadata can still be created in `pending` state and tested directly (public MCP
  servers). Other non-OK statuses during create (e.g. 502/unreachable) fail the create
  outright so users get immediate feedback rather than a phantom row.
- **PKCE S256 with encrypted verifier.** The `code_verifier` and `state` are stored
  encrypted on the server row so the callback can complete the exchange without
  server-side sessions. `state` is `${serverId}:${random}`.
- **State validation is constant-time** (`safeEqual`). The flow TTL is 10 minutes
  (`OAUTH_FLOW_TTL_MS`); expired flows must be reconnected.
- **Token exchange errors are not echoed verbatim.** Only the HTTP status is surfaced
  (e.g. `Token exchange failed (HTTP 400)`) so an upstream body that might echo the
  verifier or sensitive data never reaches the client or logs.
- **Authorization & token endpoints must be https** (unless insecure HTTP is
  explicitly enabled for local dev) and must live on the same origin as the server URL
  (`assertSameOriginRedirect`), preventing the server from redirecting us to an
  attacker-controlled host or vice versa.
- **`redirect_uri` is intentionally NOT same-origin checked.** It is built solely from
  the trusted request origin plus the fixed `/api/mcp/oauth/callback` path, so there is
  no open-redirect surface. (A same-origin assertion on `redirect_uri` would always
  fail, since the callback legitimately lives on _this app's_ origin rather than the
  MCP server's; this was corrected during implementation.)

### SSRF & redirect hardening

- `validateOutboundUrl` (`src/lib/mcp/url.server.ts`) is the single chokepoint for any
  outbound URL the server fetches. It rejects:
  - non-`https` (unless `MCP_ALLOW_INSECURE_HTTP=true`),
  - embedded credentials and URL fragments,
  - RFC1918/CGNAT/link-local/loopback addresses (loopback only allowed with insecure
    mode),
  - cloud metadata hosts (`169.254.169.254`, `169.254.170.2`,
    `metadata.google.internal`, `metadata`),
  - `.internal`/`.local` TLDs,
  - IDN/punycode hostnames (`xn--`) and any non-ASCII host,
  - non-numeric ports, URLs over 2048 chars, empty/garbage input.
- `assertSameOriginRedirect` prevents open redirects by requiring callback/token
  endpoints to share the MCP server's origin and scheme.

### Lifecycle states & UI

- **Five states** are represented: `pending` (awaiting auth), `connected`, `error`,
  `disconnected`, plus the create/`auth` dialog steps.
- **Disconnect vs. remove are distinct.** "Disconnect" (`POST .../disconnect`) clears
  stored credentials and sets `status = "disconnected"` but keeps the row, so the user
  can reconnect later. "Remove" (`DELETE`) deletes the row entirely and frees the
  free-plan slot. Remove is intentionally placed inside the Edit form (a deliberate
  pathway with its own confirmation) to avoid button-soup and accidental deletes in the
  card footer.
- **Reconnect is offered for non-connected servers** (error/disconnected/pending) and
  re-runs the authorization flow. For connected servers, "Disconnect" replaces
  "Reconnect".
- **Micro-animations:** cards fade/slide in with a staggered delay (`animate-in fade-in
slide-in-from-bottom-2`), toast messages and inline errors fade+slide, buttons use
  `active:scale-95` press feedback, the edit form uses a top-in transition, and cards
  subtly shift border color on hover. Error/disconnected cards use a destructive border
  / reduced opacity to communicate state at a glance. Animations rely on the existing
  `tw-animate-css` dependency (no new deps).
- **Feedback & error handling:** a toast system (`success`/`error`/`info`) surfaces the
  outcome of every action; the OAuth callback result is relayed to the dashboard via
  `?mcp=connected|error&reason=...` query params and cleared from the URL after showing.
  The "Connect server" button is disabled when the free limit is reached. A
  `requiresAuth` / `discoveryError` distinction is shown in the review step so users
  know whether they'll be sent to OAuth or not.

### API & authorization

- **All mutating routes use `authenticatedApiHandler` with `sameOrigin: true`** (origin
  header must match the request origin), reusing the project's existing CSRF/origin
  guard. The OAuth callback is `publicApiHandler` because it is a top-level browser
  navigation from a third-party MCP server; its security rests on the signed, encrypted
  `state` rather than the origin header.
- **Ownership is enforced in the domain layer** (`getMcpServerForUser` queries
  `id AND userId`); fetches/updates/deletes for another user's server return 404 (no
  information leak). Tests cover cross-user access for test/disconnect/delete/get.
- **No credentials in logs.** The cipher module never logs payloads; token-exchange
  errors are deliberately summarized to a status code. (There is no app-level logger
  wiring the MCP module to, so this is enforced by convention; see "unverified".)

### Database

- **New table `mcp_server`** in `drizzle/0002_noisy_ted_forrester.sql`, with a unique
  index on `(user_id, url)` so a user cannot connect the same server twice. Per the
  instructions, **migrations are not run automatically**; apply locally with
  `pnpm run db:migrate` and in production with `pnpm run db:migrate:prod`.
- Existing better-auth FK (`user_id` → `user.id`, `ON DELETE cascade`) is preserved.

## Things that could not be fully verified

- **Live OAuth against a real MCP server.** The OAuth discovery/token-exchange paths
  are covered by unit tests with injected `fetch` (including 404, 502, state mismatch,
  expiry, error status), but no real MCP server was spun up in this environment.
  Interoperability with specific MCP server implementations (e.g. exact metadata field
  names, dynamic client registration) is therefore not verified end-to-end.
- **Token refresh.** `expiresAt` is stored but no background refresh job is wired. The
  existing Cloudflare Queues/Cron boilerplate is present but not extended here; refresh
  is intentionally out of scope and `test`/reconnect will surface a reauth need if a
  token has expired.
- **Cloudflare Workers runtime behavior** of `crypto.subtle` / `atob` / `btoa`. These
  are standard Workers APIs, and the cipher unit tests run under Node's Web Crypto
  (which implements the same API), but they were not executed inside an actual Worker.
- **MCP RPC `initialize` parsing for SSE responses.** `testMcpServer` handles both JSON
  and `text/event-stream` by reading the first `data:` line; the SSE path is unit-tested
  only indirectly (JSON path). Real MCP servers may use different framing.
- **Logging hardening across the app.** There is no central logger abstraction in this
  project; the MCP modules avoid logging tokens by construction, but a future global
  request logger could inadvertently log request/response bodies. This is left to the
  host app's observability configuration.
- **Production screenshots.** Capturing real screenshots requires a running dev server
  with auth, D1, and a configured `MCP_ENCRYPTION_KEY`; this is tracked as a nice-to-have
  and not included unless a running environment is provided.
- **Dynamic client registration (`registration_endpoint`).** The metadata field is
  parsed and returned to the client but no client-registration step is implemented;
  servers requiring registration before authorization will fail at the authorize step
  with a clear message. Documented as a known limitation.

## Testing summary

`pnpm test` runs 61 tests across three files (no external services needed):

- `url.server.test.ts` — SSRF, scheme, credentials, IDN, private/metadata hosts,
  redirect same-origin enforcement.
- `crypto.server.test.ts` — AES-GCM round trip, random IV, wrong key, tamper, corrupt
  blobs.
- `core.server.test.ts` — the 3-server free limit (under/at/over + pro unlimited),
  safe projection leaks, cross-user authorization (404), create/discover/complete/test/
  edit/disconnect/delete flows, OAuth state mismatch, expiry, error parameters,
  unreachable servers. Uses a real in-memory SQLite (better-sqlite3) D1 adapter so the
  actual drizzle query builder is exercised, with billing mocked.

## Run/apply checklist

```bash
pnpm install
# generate + apply the migration locally (NOT applied automatically)
pnpm run db:generate
pnpm run db:migrate
# set the encryption secret in .env.local (or wrangler secret in prod)
#   MCP_ENCRYPTION_KEY=<32-byte base64>  (see .env.example)
pnpm run dev
pnpm exec vp check   # format + lint + typecheck
pnpm test           # 61 passing
```
