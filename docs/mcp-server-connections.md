# MCP server connections — implementation notes

This document records the micro-decisions and assumptions made while building the
"connect MCP servers" feature on the dashboard, plus anything that could not be
fully verified during implementation.

## Feature overview

- Users manage MCP server connections at `/dashboard` (grid of cards with
  connect / reconnect / edit / test / disconnect / remove).
- Domain logic lives in `src/lib/mcp/`; API routes in `src/routes/api/mcp/`;
  UI in `src/components/mcp/`.
- New tables: `mcp_server` (one row per connection) and `mcp_oauth_session`
  (short-lived OAuth state + PKCE verifier). Migration:
  `drizzle/0002_gigantic_miracleman.sql` — **not applied automatically**; run
  `pnpm db:migrate` (local) / `pnpm db:migrate:prod` yourself.
- New env secret: `MCP_TOKEN_ENCRYPTION_KEY` (base64, 32 bytes — see
  `.env.example`). Must be provisioned via environment secrets
  (`wrangler secret put`), never the database or source.

## Connection flow

1. **Create** (`POST /api/mcp/servers`): validates name/URL, enforces the plan
   limit, stores the server as `pending_auth`.
2. **Connect** (`POST /api/mcp/servers/$id/authorize`): probes the server with
   an MCP `initialize` request.
   - Success → no auth needed; marked `connected` (`authType: "none"`).
   - 401 → OAuth discovery (RFC 9728 protected-resource metadata →
     RFC 8414 / OIDC authorization-server metadata), dynamic client
     registration (RFC 7591), then the browser is redirected to the
     authorization endpoint with PKCE (S256) + `state` + `resource`
     (RFC 8707).
3. **Callback** (`GET /api/mcp/oauth/callback`): validates the single-use
   state (bound to the signed-in user, 10-minute TTL), exchanges the code
   server-side, encrypts tokens, re-probes with the token, and redirects to
   `/dashboard?mcp=connected|error`.
4. **Test / reconnect / edit / disconnect / remove** map to the remaining
   routes; access tokens are refreshed automatically (60s leeway) when a
   refresh token is available.

## Micro-decisions and assumptions

### Product / UX

1. **"Disconnect" vs "Remove" are separate actions.** The brief lists a
   disconnect state; I kept the server row (with its client registration) on
   disconnect so reconnecting is one click, and added an explicit destructive
   "Remove" (with confirmation) that deletes the row entirely.
2. **The dashboard section is self-contained** and uses plain `fetch` +
   `useState`, mirroring the existing billing page rather than introducing
   react-query usage (the provider exists but no page uses it yet).
3. **Limit UX**: free users see "N of 3" with a segment meter; at the limit the
   "Add server" tile becomes an upgrade prompt linking to `/billing`. The
   create dialog also handles the 402 response with an upgrade CTA, since the
   grid state could be stale.
4. **Connect dialog shows a three-step progress list** (save → probe/discover →
   authorize handoff) and pauses ~600 ms before the OAuth redirect so the
   handoff doesn't feel abrupt. Errors after creation keep the server and
   offer "Try again" — the card then shows the error state too.
5. **Status colors** use emerald (connected) and amber (needs re-auth) in
   addition to the theme's destructive red. The template palette has no
   success/warning tokens; introducing the two conventional hues seemed better
   UX than overloading `primary`.
6. **Micro-animations** reuse the already-bundled `tw-animate-css` utilities:
   staggered card entrances, ping status dot, rotating plus on the add tile,
   hover lift, step check-ins, test-result flash, and a temporary highlight
   ring on a freshly connected card. All entrance/ping animations respect
   `motion-reduce` via the dot's `motion-reduce:hidden` echo; the rest are
   opacity/transform transitions of ≤300 ms.
7. **Copy targets a technical user** (mentions streamable HTTP, OAuth
   discovery) per the ICP.

### Billing / limits

8. **Reused the existing entitlement system**: `pro_monthly` gains an
   `unlimited_mcp_servers` entitlement and the catalog gains
   `limits.freeMcpServers = 3` (`src/lib/billing/config.ts`). The API checks
   `hasEntitlement(...)` server-side on every create; the client only mirrors
   the result for display.
9. **Limit races**: D1 exposes no transactions across statements here, so
   create re-counts after insert and deletes the row if the limit was
   exceeded concurrently (compensating check). A determined racer cannot end
   up above the limit with a persisted row.
10. **Downgrade behavior**: if a pro user with >3 servers downgrades, existing
    servers keep working but no new ones can be added until under the limit.
    Nothing is deleted automatically.

### Protocol

11. **Streamable HTTP transport only.** The probe sends a JSON-RPC
    `initialize` POST (protocol version `2025-06-18`) and accepts JSON or SSE
    responses. The legacy HTTP+SSE (GET) transport is not supported.
12. **The probe does not complete the full MCP lifecycle** (no
    `notifications/initialized`, no session reuse). It is a connectivity +
    identity check; chat integration would open its own session. Some strict
    servers may log an abandoned init — considered acceptable for a health
    check.
13. **Capabilities are summarized to booleans** (tools/resources/prompts) for
    the card UI rather than storing the full capability object.
14. **403 is treated as an error, not an auth prompt** — only 401 triggers the
    OAuth flow, per the MCP auth spec.
15. **`getMcpAccessToken()` is exported** from `core.server.ts` as the hook for
    future chat-session usage (decrypts and auto-refreshes). No chat feature
    exists in the template yet, so wiring MCP tools into chat was left out of
    scope.

### OAuth

16. **Discovery order**: `WWW-Authenticate: resource_metadata` hint → path-aware
    then root `/.well-known/oauth-protected-resource` → authorization server
    from `authorization_servers[0]` → path-aware/root
    `oauth-authorization-server` → `openid-configuration`. If no protected
    resource metadata exists, the MCP server origin is assumed to be the
    issuer (pre-2025-06-18 spec behavior).
17. **Only `authorization_servers[0]` is used** when several are advertised.
18. **Dynamic client registration requests a public client**
    (`token_endpoint_auth_method: "none"`); if the AS returns a secret anyway,
    it is stored encrypted and sent via `client_secret_post`. Servers that
    require OAuth but offer no registration endpoint fail with a clear 422 —
    manual client credential entry was deliberately left out to keep the flow
    simple.
19. **Client registrations are reused** across reconnects while the issuer is
    unchanged, to avoid piling up registrations. Changing the server URL
    resets all auth state.
20. **Scopes**: requested scopes come from the protected-resource metadata's
    `scopes_supported` (fallback: AS metadata). If none are advertised, no
    `scope` parameter is sent.
21. **PKCE is mandatory** (S256). An AS that advertises
    `code_challenge_methods_supported` without S256 is rejected.
22. **`resource` (RFC 8707) is sent** on authorize, token, and refresh
    requests, set to the normalized server URL.
23. **State tokens** are 256-bit random, single-use (deleted before
    validation), user-bound, and expire after 10 minutes. The PKCE verifier is
    stored encrypted. Expired sessions are opportunistically pruned per user.
24. **Token revocation on disconnect/remove is best-effort** (refresh token
    preferred, falling back to access token) and never blocks the local
    deletion.
25. **Access tokens without `expires_in` never auto-refresh** — they are used
    until the server returns 401, which flips the card to "needs
    re-authentication".

### Security

26. **Encryption**: AES-256-GCM via WebCrypto with a random 96-bit IV per
    value; payload format `v1.<iv>.<ciphertext>` to allow future rotation.
    Encrypted: access tokens, refresh tokens, client secrets, PKCE verifiers.
    The key comes only from `MCP_TOKEN_ENCRYPTION_KEY`. There is no key
    rotation mechanism yet — rotating the key invalidates stored tokens
    (users would reconnect).
27. **SSRF**: user URLs and _every_ discovered endpoint must be public https —
    no credentials in the URL, no localhost/`.local`/`.internal`/`.onion`
    hosts, no private/link-local/CGNAT/metadata IPv4 ranges, no
    loopback/ULA/link-local/NAT64/IPv4-mapped IPv6. WHATWG URL parsing
    canonicalizes decimal/hex IP forms before the check. Because https-only is
    enforced, `http://localhost` dev MCP servers cannot be connected — a
    deliberate trade-off; the app itself runs on Workers where localhost
    would be meaningless anyway.
28. **Redirects are never auto-followed.** Discovery GETs follow up to 3
    redirects manually, re-validating each hop against the SSRF rules and
    dropping `Authorization` on cross-origin hops. POSTs (token, registration,
    revocation) refuse redirects outright. The MCP probe refuses redirects.
29. **DNS rebinding is a residual risk**: hostnames are validated, but the
    worker cannot pin resolved IPs with the standard `fetch`. On Cloudflare's
    egress this cannot reach the user's network, only (already firewalled)
    infrastructure. Documented rather than solved.
30. **The OAuth callback only ever redirects to fixed internal paths**
    (`/dashboard`, `/sign-in`) — nothing attacker-influenced.
31. **No secrets in responses or logs**: `toPublicMcpServer()` is the only
    serializer used by routes; token responses from the AS are parsed
    field-by-field and error bodies are reduced to the standard `error` code
    (verified by test). `console.error` is avoided in MCP code paths except a
    static message in the callback.
32. **Mutating routes require same-origin** (`Origin` header check), matching
    the billing checkout pattern, alongside better-auth session cookies.
33. **The states/limits are enforced in domain functions, not the UI** — every
    route resolves ownership via `(id, userId)` so cross-tenant access 404s
    (covered by tests).

### Engineering

34. **Route params**: the shared `publicApiHandler`/`authenticatedApiHandler`
    in `src/lib/api.ts` now pass through TanStack's route `params`
    (additive; existing routes unaffected).
35. **The "test connection" route is named `/ping`** because a file named
    `servers.$serverId.test.ts` is picked up by the vitest `*.test.ts` glob.
    UI copy still says "Test".
36. **Domain functions take `(db, key, args, deps)`** with injectable
    network collaborators (probe/discover/register/exchange/refresh/revoke) so
    tests run against an in-memory SQLite database (better-sqlite3) executing
    the _real_ generated migrations — no network, no mocks of the DB layer.
37. **`better-sqlite3` is cast to the D1 `DB` type in tests.** The drizzle
    query API is identical at runtime; this is the standard trade-off for
    testing D1 apps without miniflare.
38. **Server names are capped at 60 chars**; URLs are normalized (hash
    stripped, WHATWG canonicalization) and unique per user
    (`(user_id, url)` unique index).
39. **`updatedAt` housekeeping** is done in application code (matching the
    billing module) rather than DB triggers.

## Verified end-to-end (local dev, 2026-07-17)

- `vp check` (format, lint, type check) and `vp test run` (78 tests) pass.
- **No-auth connect**: `https://docs.mcp.cloudflare.com/mcp` connected live —
  `initialize` handshake parsed (`docs-ai-search v0.4.9`, protocol
  `2025-06-18`, tools + prompts capabilities shown on the card).
- **OAuth discovery + dynamic client registration**, live against two real
  servers (`bindings.mcp.cloudflare.com`, `mcp.sentry.dev`): 401 → metadata
  discovery → DCR (real client ids issued) → authorization URL with PKCE
  S256, state, and `resource`; the browser landed on Sentry's real consent
  screen showing our registered client name and callback URL. Authorization
  was **not** approved (that would grant access to a real account), so the
  code-exchange callback was exercised only via its error paths
  (`access_denied`, invalid state, unauthenticated → `/sign-in`) plus unit
  tests for the happy path.
- **Limit + security paths over HTTP**: 4th server → 402 with
  `mcp_server_limit`; private-IP URL → 400; missing `Origin` on POST → 403;
  unauthenticated API → 401.
- **UI flows in a real browser**: grid states (connected / not connected /
  needs re-auth), 3-of-3 limit meter + upgrade tile, connect dialog with
  animated step progress, OAuth handoff, error banner absorb + URL cleanup,
  remove confirmation. See `docs/screenshots/`.

## Not fully verified

- **OAuth token exchange, refresh, and revocation against a live server.**
  Completing the flow requires approving access to a real third-party
  account. These paths are covered by unit tests with mocked authorization
  server responses.
- **SSE-formatted `initialize` responses** are parsed from the first `data:`
  line of the buffered body; servers that keep the stream open indefinitely
  before sending the first event would hit the 10 s probe timeout. Not
  verified against such a server.
- **`wrangler types` regeneration** was not run (the D1 `database_id` in
  `wrangler.jsonc` is still the template placeholder), so
  `MCP_TOKEN_ENCRYPTION_KEY` is typed via the `McpEnv` interface instead of
  the generated `worker-configuration.d.ts`.
- **Cloudflare egress blocking of private ranges** (decision 29) is assumed,
  not tested from inside this worker.

## Screenshots

| File                                          | Shows                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `screenshots/01-dashboard-mcp-grid.png`       | Grid with connected / pending / needs-re-auth cards, limit meter, upgrade tile |
| `screenshots/02-connect-dialog.png`           | Connect dialog with name + URL form                                            |
| `screenshots/03-remove-confirmation.png`      | Destructive remove confirmation                                                |
| `screenshots/04-connect-progress-steps.png`   | Animated step progress during connect (save → discover → handoff)              |
| `screenshots/05-oauth-authorization-page.png` | Real Sentry consent screen for our DCR-registered client                       |
| `screenshots/06-callback-declined-banner.png` | Error banner after a declined authorization                                    |
