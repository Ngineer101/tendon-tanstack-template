# MCP Server Connections — Design Notes

This document captures the micro-decisions and assumptions made while
implementing per-user MCP (Model Context Protocol) server connections on the
dashboard, so reviewers and future maintainers can reason about the choices and
spot anything that should be verified against production behavior.

## Feature summary

- Dashboard (`/dashboard`) gains an **MCP servers** panel showing connected
  servers in a grid and a **Connect server** flow (URL → OAuth discovery →
  authorize → encrypted credential storage).
- Free users can connect **3** MCP servers; Pro subscribers have an
  **unlimited** allowance. The limit is enforced server-side against the
  existing billing/subscription projection in D1.
- Each connection performs OAuth 2.1 + PKCE against the server's
  [authorization server metadata][rfc8414], discovered at
  `<server_url>/.well-known/oauth-authorization-server`.
- OAuth tokens are encrypted at rest (AES-GCM-256) with an env-managed key and
  are never returned to the browser.
- Lifecycle states supported in the UI: **connect, reconnect, edit, test,
  disconnect, delete**, plus **pending** and **error** states surfaced from the
  server.

## Architecture

| Layer        | Location                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| DB schema    | `src/db/schema.ts` (`mcp_server`, `mcp_oauth_state`)                                                               |
| Migration    | `drizzle/0002_pink_tombstone.sql` (apply with `pnpm run db:migrate`)                                               |
| Domain logic | `src/lib/mcp/*` (crypto, ssrf, oauth, core, config)                                                                |
| API routes   | `src/routes/api/mcp/servers/index.ts`, `src/routes/api/mcp/servers/$id.ts`, `src/routes/api/mcp/oauth/callback.ts` |
| UI           | `src/components/mcp/*` (panel, card, connect dialog) + updated `src/routes/_protected/dashboard.tsx`               |
| Cron cleanup | `src/worker/crons.ts` purges expired OAuth states                                                                  |
| Tests        | `src/lib/mcp/*.test.ts`                                                                                            |

## Micro-decisions & assumptions

### Identity & lifecycle

- **A server is identified by its origin.** `validateServerUrl` normalizes the
  user input to `${origin}/` and rejects paths beyond `/`. This keeps the
  server URL a stable identity key and a unique constraint
  (`mcp_server_user_id_server_url_unique`) per user.
- **`disconnected` servers do not count toward the limit.** Disconnecting
  wipes credentials but keeps the row, so users can reconnect without
  consuming a new slot. Only rows whose status is not `disconnected` count.
  Deleting a server frees the slot entirely.
- **Status states are `pending | connected | disconnected | error`.** `pending`
  means metadata was discovered and the OAuth flow started but not completed;
  the user can reconnect to retry.

### Limit & entitlements

- **The free limit is 3 (`FREE_MCP_SERVER_LIMIT`).** It is enforced inside
  `assertUnderLimit` on every `connectServer` call, _before_ any DB insert, so
  a race between two simultaneous connects could theoretically still both pass
  the count check. This mirrors the existing billing pattern (conditional D1
  update for credits), but for inserts there is no atomic conditional insert
  used here. If abuse is a concern, add a transaction or a `SELECT … FOR`
  guard — see "Couldn't be fully verified".
- **Pro override reads the existing subscription projection.** Rather than
  depending on the Stripe env (which the MCP layer doesn't need), `hasUnlimitedAllowance`
  reads `billing_account` + `subscription` and checks for an active
  `pro_monthly` subscription. This mirrors `getBillingSummary`'s plan detection
  so limit enforcement stays consistent with the entitlement system without
  weakening it.
- **The unlimited entitlement is `premium_dashboard`.** This is the only
  entitlement declared in the catalog, so we reuse it. Replacing it with a
  dedicated `mcp_unlimited` entitlement would require a catalog change and a
  webhook replay; deferred.

### OAuth flow

- **OAuth 2.1 + PKCE (S256), public client.** No stored client secret is
  required for the user's MCP server. If the server supports
  [Dynamic Client Registration][rfc7591] (`registration_endpoint`), we register
  a client on the fly and store its `client_id`/`client_secret` (encrypted)
  alongside the tokens. DCR failures soft-fall back to the public PKCE flow.
- **State is single-use and short-lived.** `mcp_oauth_state` stores the PKCE
  verifier + state nonce with a 10-minute TTL. The callback deletes the row
  before exchanging the code, so a replayed `state` is rejected. A cron
  (`*/15 * * * *`) calls `purgeExpiredOAuthStates` to clean up rows left by
  aborted attempts or crashes.
- **Redirect URI** defaults to `${BETTER_AUTH_URL}/api/mcp/oauth/callback` and
  can be overridden by `MCP_OAUTH_REDIRECT_URL` for custom domains.
- **Discovery endpoint** is `<server_url>/.well-known/oauth-authorization-server`
  ([RFC 8414][rfc8414]). Some MCP server implementations historically served
  metadata at a resource-specific path; this implementation uses the
  root-relative path, which matches the current MCP authorization spec.
- **`scope`** defaults to `"mcp"` only if the metadata does not already suggest
  a scope via the authorization URL. This is conservative; many MCP servers
  accept an empty or opaque scope.

### Security

- **Encryption at rest**: AES-GCM-256 with a 96-bit random IV per record. The
  key is a base64-encoded 32-byte raw key in `MCP_ENCRYPTION_KEY` (env secret,
  via `.env.local` locally and `wrangler secret put` in prod). Keys are never
  logged and never returned to the client — `McpServerPublic` carries only
  `hasCredentials`, never the blob.
- **Cleartext never logged.** All error paths (`markError`, `ApiError`)
  persist only a short, sanitized human message; tokens/secrets are never
  serialized into `lastError` or any `console.*` call. The OAuth callback
  sanitizes the error message before placing it in the redirect URL.
- **SSRF**: `validateFetchUrl` (used by all server-side fetches) restricts
  scheme to https (http only for localhost when `BETTER_AUTH_URL` is localhost),
  rejects embedded userinfo, blocks known cloud metadata hostnames
  (`metadata.google.internal`, `169.254.169.254`, …), and blocks raw IP
  literals in private/loopback/link-local ranges. `validateServerUrl` adds the
  root-path restriction for the user-entered URL. `safeFetch` re-validates
  every redirect hop up to a small max and aborts on redirect loops or unsafe
  targets, blocking redirect-based SSRF.
- **Self-SSRF**: `connect`/`discover` reject server URLs whose hostname matches
  the app's own `BETTER_AUTH_URL` hostname.
- **Unsafe redirects**: the OAuth callback always redirects to `/dashboard`
  (same origin) with a sanitized, length-capped message; it never redirects to
  a URL taken from the request body or the MCP server.
- **Keys in env, not DB/code.** Verified the key is read from
  `env.MCP_ENCRYPTION_KEY`, never persisted, never defaulted. A missing or
  wrong-length key throws `ApiError(500)` rather than silently weakening crypto.

### UI & UX

- **Grid** uses the existing `Card`/`Badge`/`Button` components and the same
  `font-mono text-xs uppercase tracking-[0.2em] text-primary` section header
  pattern as the billing page.
- **Micro-animations** use the project's existing `tw-animate-css` utilities
  (`animate-in fade-in-0 slide-in-from-bottom-*`) — staggered grid cards,
  dialog step transitions keyed on step, toast slide-in, skeleton pulse, and
  the dialog's built-in zoom-in.
- **Feedback**: a timed toast (`useTimedFlag`) confirms each action; inline
  error banners surface load failures; the connect dialog has explicit
  `discovering`/`connecting`/`error` steps with spinner affordances and an
  `aria-live` region for screen readers while the redirect is in-flight.
- **Connect reuses fetch against `/api/mcp/servers`** (same pattern as the
  billing page's `fetch` calls), keeping the client intentionally simple with
  no client-side secrets.

## Couldn't be fully verified

- **DNS-based SSRF on Cloudflare Workers.** Workers cannot pre-resolve DNS
  before `fetch`, so we validate hostnames/IP literals heuristically rather
  than by resolved address. A server that resolves a public hostname to a
  private IP (DNS rebinding) is not blocked at the DNS layer. Mitigations in
  place (https-only, blocked hostnames, re-validated redirect hops) reduce but
  do not eliminate this class. A future hardening could fan out the fetch
  through a proxy that pins resolved IPs.
- **Full MCP protocol initialization.** `testServer` performs a minimal bearer
  GET against the server URL and checks the status code; it does not run the
  full MCP initialize handshake. A server that returns 200 for an unauthenticated
  GET but requires MCP-specific headers may report a misleadingly healthy
  status. This is intentionally cheap for the starter; real MCP probe logic can
  be layered into `testServer` later.
- **Atomic limit enforcement under concurrency.** As noted above, two
  concurrent `connectServer` calls for a free user at the boundary could both
  pass the count check before either inserts. The unique `(user_id, server_url)`
  index prevents duplicates but not over-counting. A D1 transaction around
  count+insert would close the window; not added here to avoid coupling MCP to
  D1-specific transaction semantics beyond the existing patterns.
- **Per-server entitlements.** The implementation ties unlimited allowance to
  the single existing Pro entitlement. If the catalog later adds a dedicated
  `mcp_unlimited` entitlement, the constant in `core.server.ts` should be
  updated and the catalog extended.
- **Real MCP server compatibility.** Discovery and token exchange were
  validated against the spec and mocked endpoints in tests, not against a live
  third-party MCP server, since none was available in this environment.

## Setup

```sh
# 1. Generate the AES key
pnpm exec tsx src/lib/mcp/scripts/generate-key.ts   # prints a base64 key

# 2. Add to .env.local locally
MCP_ENCRYPTION_KEY=<printed value>

# 3. Set the production secret
pnpm exec wrangler secret put MCP_ENCRYPTION_KEY

# 4. Apply the D1 migration (not run automatically)
pnpm run db:migrate        # local
pnpm run db:migrate:prod   # production

# 5. Run tests
pnpm exec vp test run

# 6. Lint/typecheck/format
pnpm exec vp check
```

The migration is **not** applied automatically and this project is **not**
auto-deployed; both must be run explicitly per the task constraints.

[rfc8414]: https://datatracker.ietf.org/doc/html/rfc8414
[rfc7591]: https://datatracker.ietf.org/doc/html/rfc7591
