# MCP server connections — implementation notes

This document records the micro-decisions and assumptions made while building the
MCP server connection feature, plus anything that could not be fully verified.

## Overview

Users connect Model Context Protocol (MCP) servers from `/dashboard`. The flow is:

1. User enters a name and a Streamable HTTP MCP endpoint URL.
2. The backend probes the server with a JSON-RPC `initialize` request.
   - If the server answers, it is saved as **connected** (`authType: none`).
   - If it answers `401`, the backend runs OAuth discovery (RFC 9728 protected
     resource metadata → RFC 8414 authorization server metadata → RFC 7591
     dynamic client registration) and saves the server as **pending_auth**.
3. For OAuth servers the user is redirected to the authorization server
   (authorization code + PKCE S256 + RFC 8707 `resource` indicator), then back to
   `/api/mcp/oauth/callback`, which exchanges the code, encrypts the tokens, and
   marks the server connected.
4. Cards support **test** (live `initialize` + `tools/list`, latency reported),
   **edit** (rename or change URL), **reconnect** (re-run OAuth), and
   **disconnect** (delete row + auth material).

Free users can connect 3 servers; Pro users are unlimited via the existing
entitlement system (`unlimited_mcp_servers` added to the `pro_monthly` plan).

## Micro-decisions

### Data model

- **Two tables**: `mcp_server` (the connection) and `mcp_oauth_session`
  (short-lived OAuth state, 10-minute TTL; the row id doubles as the OAuth
  `state` parameter). Sessions are single-use and deleted before the token
  exchange to prevent replay.
- **One encrypted blob per server** (`encrypted_auth`) holding access token,
  refresh token, scope, expiry, client id/secret, token endpoint, and resource —
  rather than one column per secret. Simpler to encrypt atomically and rotate.
- **Non-secret discovery metadata** (`oauth_metadata`: endpoints, scopes, client
  id) is stored as plaintext JSON so reconnects don't re-run discovery. Client
  ids are public identifiers; client secrets never go in this column.
- **Server URL is stored in plaintext** and is part of a per-user unique index.
  Query strings are preserved (some servers key transports off them) but
  fragments and trailing slashes are stripped for canonical comparison.
- **Status enum**: `connected | pending_auth | error`. "Disconnected" is not a
  status — disconnecting deletes the row, as keeping revoked tokens around has
  no upside.

### Security

- **Encryption**: AES-256-GCM via WebCrypto with a random 96-bit IV per write.
  Key comes from the `MCP_TOKEN_ENCRYPTION_KEY` environment secret (base64,
  32 bytes) — never from the database or source. A wrong-length or malformed key
  fails loudly at first use.
- **SSRF guard** (`url-guard.server.ts`): user-supplied _and discovered_ URLs
  (resource metadata, authorization/token/registration endpoints) must be https
  and must not point at loopback, RFC 1918, link-local (incl. 169.254.169.254
  metadata), CGNAT, multicast, `.local`/`.internal`/no-dot hostnames, or private
  IPv6 (`::1`, `fc00::/7`, `fe80::/10`, mapped IPv4). URLs with embedded
  credentials are rejected. Outbound fetches use `redirect: "manual"` — a 3xx
  from an MCP server is treated as an error, never followed.
- **Dev escape hatch**: `MCP_ALLOW_PRIVATE_NETWORK=true` permits http/localhost
  for local development only. Documented in `.env.example` as never for prod.
- **Redirect safety**: the OAuth callback only ever redirects to a fixed
  `/dashboard` path on the request's own origin, with enumerated result codes
  (`access_denied`, `state_invalid`, `oauth_failed`, `callback_failed`) —
  provider-supplied strings are never echoed into the redirect.
- **Log/leak hygiene**: network failures are mapped to generic `ApiError`s so
  raw errors (which can embed URLs with query secrets) never reach clients or
  logs; token endpoint failures surface only the standard OAuth `error` code,
  not the response body. The API serializer whitelists fields — `encrypted_auth`
  and `oauth_metadata` are never sent to the client.
- **CSRF**: mutating routes reuse the project's existing `sameOrigin` origin
  check; the OAuth `state` is a random UUID bound to the user in the DB and the
  callback verifies the session user matches the state's owner.
- **Limit enforcement is server-side**: a pre-check before the probe (fast
  feedback) plus an authoritative post-insert count check that removes its own
  row if a concurrent create pushed the user over the limit (D1 has no
  multi-statement transactions outside `batch`; this compensating check can
  under-admit but never over-admit).

### OAuth specifics

- **Dynamic client registration only** (`token_endpoint_auth_method: "none"`,
  public client + PKCE). Authorization servers without a registration endpoint
  get a clear error. Manual client-credential entry was deliberately left out of
  scope — most modern MCP servers (Linear, Sentry, Cloudflare, …) support DCR.
- **Discovery fallbacks** mirror the MCP auth spec: `WWW-Authenticate`
  `resource_metadata` hint → path-aware then root
  `/.well-known/oauth-protected-resource` → authorization server metadata at
  `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`
  (path-inserted and path-appended variants). If no protected-resource metadata
  exists, the MCP server origin itself is assumed to be the authorization server.
- **Scopes**: `scopes_supported` from resource metadata (fallback: AS metadata)
  are requested verbatim; if none are advertised, no `scope` parameter is sent.
- **Token refresh** happens lazily (on test or token use) with 30s leeway, and
  rotated refresh tokens are persisted. A failed refresh flips the server to
  `pending_auth` with a "reconnect" message instead of a dead `error` state.
- **After the token exchange** the backend re-probes with the new token before
  declaring the server connected, so a bad grant is caught immediately.

### Product/UX

- **Connect-time failures don't persist a row** — a typo'd URL doesn't leave a
  broken card behind or consume a limit slot.
- **Editing the URL resets authorization** (tokens wiped, discovery re-run):
  tokens minted for one resource must never be sent to another.
- **Rename-only edits skip the network probe** entirely.
- **`tools/list` count is best-effort**: a server that rejects it (or needs a
  session handshake we don't fully complete) still connects; the count is
  informational.
- **Test connection** reports round-trip latency and refreshes server metadata;
  a 401 during test moves the card to "Needs authorization" with a Reconnect
  action rather than a generic error.
- **"Reconnect" vs "Connect" label** is inferred from `lastConnectedAt` — the
  client is not told whether stored auth exists.
- **The 3-server meter** renders as three filling segments; at the limit the
  "add" tile becomes an upgrade prompt linking to `/billing`.
- **Micro-animations**: staggered card entrance (60ms steps, capped), hover
  lift + border tint, pulsing status dot for connected servers, animated
  discovery checklist in the connect dialog (visual cursor advances on a timer;
  the _outcome_ is always the real server response), zoom-in success check,
  latency badge pop, and action-icon reveal on card hover. All via the
  `tw-animate-css` utilities already in the project.

### Code structure

- Domain logic lives in `src/lib/mcp/` and takes a `deps` object (db, key,
  fetch) instead of importing `cloudflare:workers`, so it runs under plain
  vitest with better-sqlite3 against the real drizzle migration files.
- `src/lib/api.ts` was extended (backwards-compatibly) to pass route params
  into the existing `authenticatedApiHandler` wrapper.
- API error contract: `ApiError` with a machine-readable `code` in `details`
  (`server_limit_reached`, `duplicate_server`, `invalid_url`, `unreachable`,
  `oauth_*`, `not_found`), consumed by the UI for targeted messaging.
- The UI uses TanStack Query (already wired into the app shell) rather than the
  manual `fetch`+`useState` pattern of the billing page, to get invalidation
  after mutations.
- `getMcpAccessToken()` is exported from `core.server.ts` as the intended
  server-side entry point for future chat-session integration (returns a fresh
  token, refreshing if needed; tokens never leave the server).

## Assumptions

- **Transport**: only Streamable HTTP MCP servers are supported (POST JSON-RPC,
  JSON or SSE responses). The legacy HTTP+SSE (2024-11-05) transport and stdio
  servers are out of scope. The SSE parser accepts `\r\n`, `\r`, and `\n` line
  endings — a real-world requirement discovered while testing against DeepWiki,
  which emits CRLF-terminated events.
- **"Paying users"** means an active/trialing `pro_monthly` subscription — the
  only paid plan in the catalog. Credit-pack purchases do not lift the limit.
- **Chat integration is future work**: the template has AI SDK dependencies but
  no chat route yet, so "usable in chat sessions" is satisfied by persisting
  connections and exposing `getMcpAccessToken()` for that integration.
- A `403` (not `402`) is returned for the limit, since upgrading is a plan
  change rather than a metered payment.
- DNS rebinding cannot be fully prevented from a Cloudflare Worker (no resolver
  control); the guard is lexical. In production the Workers runtime cannot reach
  the deployer's private network, which bounds the blast radius.
- `Response.redirect` with 303 is used for the callback; session cookies are
  assumed `SameSite=Lax` (better-auth default), which sends them on top-level
  GET navigations — required for the callback to see the user session.

## Verified live (local dev, real servers)

- Connecting `https://docs.mcp.cloudflare.com/mcp` and
  `https://mcp.deepwiki.com/mcp` end-to-end from the dashboard UI: probe,
  `tools/list` counts, connected cards, test-connection latency badge.
- OAuth discovery + dynamic client registration against **Linear's production
  authorization server**: connecting `https://mcp.linear.app/mcp` produced the
  pending-auth state, and "Continue to authorize" redirected to
  `https://mcp.linear.app/authorize` with a real DCR-issued `client_id`, PKCE
  S256 challenge, `state`, `resource`, and discovered scopes.
- The 3-server limit (UI upgrade tile and a direct API call returning
  403 `server_limit_reached`), SSRF rejections via the live API
  (`http://…` and `https://localhost` → 400 `invalid_url`), edit/rename,
  disconnect with confirmation, and the callback error redirect
  (`?state=bogus` → `/dashboard?mcp_error=state_invalid` banner).

## Not fully verified

- **OAuth token exchange against a real provider**: the callback → token
  exchange → encrypted persistence loop is covered by unit tests against a
  simulated OAuth server (discovery, DCR, PKCE, exchange, refresh,
  replay/expiry/cross-user rejection), but completing it against Linear would
  have required signing into a real third-party account, which was not done.
- **SSE long-poll behavior on exotic servers**: the SSE parser stops reading at
  the first matching JSON-RPC id (tested), but real servers that never emit a
  response body would only be bounded by the 10s request timeout.
- **`wrangler secret put MCP_TOKEN_ENCRYPTION_KEY` in production** was not run
  (no deploy was performed, per instructions). Migrations were generated
  (`drizzle/0002_giant_tiger_shark.sql`) and applied only to the **local** dev
  D1 database for verification — production migration is left to the operator:
  `pnpm db:migrate:prod`.
- **Token revocation on disconnect**: RFC 7009 revocation is not attempted;
  disconnect deletes local state only. Most MCP authorization servers expire
  tokens quickly; documenting rather than implementing kept scope contained.
