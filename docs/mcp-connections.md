# MCP Server Connections — Design Notes

Feature added to the `/dashboard` page letting users connect Model Context
Protocol (MCP) servers to their account. Free users can connect up to **3**
servers; Pro users get unlimited connections. Connection state is persisted in
D1 with OAuth tokens encrypted at rest using a key held only in a Workers
secret.

This document records the micro-decisions, assumptions, and items that could
not be fully verified during implementation, per the task brief.

## Architecture overview

```
src/lib/mcp/
  config.server.ts      env typings + FREE_SERVER_LIMIT + status enum
  url.server.ts         SSRF / scheme / redirect re-validation (pure)
  crypto.server.ts      AES-GCM encrypt/decrypt of auth data (pure)
  state.server.ts       HMAC-signed, short-lived OAuth "state" tokens
  oauth.server.ts       PKCE (S256), authz URL builder, scope sanitizer
  discovery.server.ts   OAuth discovery (RFC 8414 + MCP protected-resource)
  client.server.ts      DCR, token exchange, revocation
  entitlements.server.ts 3-server limit decision + 402 McpLimitError
  id.server.ts          id helper (kept separate for mocking)
  core.server.ts        CRUD + OAuth flow + ownership + encryption-at-rest

src/components/mcp/
  types.ts               client-safe projection types + status metadata
  McpConnections.tsx     dashboard section + grid + connect CTA
  McpServerCard.tsx      card with connect/reconnect/edit/test/disconnect
  ConnectMcpDialog.tsx   multi-step connect flow (form → discover → redirect)

src/routes/api/mcp/
  servers.ts             GET  /api/mcp/servers
  connect.ts             POST /api/mcp/connect
  oauth/callback.ts      GET  /api/mcp/oauth/callback  (external redirect)
  edit/$serverId.ts      PATCH
  test/$serverId.ts      POST
  reconnect/$serverId.ts POST
  disconnect/$serverId.ts DELETE

drizzle/0002_faithful_kingpin.sql   adds `mcp_server` table
```

## Micro-decisions / assumptions

1. **Server-side limit enforcement.** The 3-server limit is enforced in
   `core.server.ts` (`beginConnection`) by counting active+pending rows and
   calling `assertCanConnectServer` **before** running discovery or inserting a
   row. The UI also shows the remaining quota but is not authoritative. The
   underlying entitlement comes from the existing billing/plan system: any
   active `pro_monthly` subscription grants the `unlimited_mcp_servers`
   entitlement (added to `BILLING_CATALOG.subscriptionPlans.pro_monthly`).
2. **Plan resolved directly from D1.** Rather than reusing
   `getBillingSummary` (which lives in `lib/billing/core.server` and is typed
   to require the full set of `STRIPE_*` env vars), `loadPlan` reads
   `billingAccount` + `subscription` rows directly. This keeps the MCP surface
   decoupled from Stripe env wiring and avoids weakening/re-purposing the
   billing module. Plan semantics mirror `getBillingSummary`: any active
   `pro_monthly` subscription → `pro_monthly`.
3. **Limit counts active + pending, not "disconnected".** "disconnected" is a
   terminal state implemented as a hard `DELETE` of the row (see #5), so it does
   not consume a slot. "pending" (created but not yet authorized) is counted so
   a user cannot bypass the limit by spamming draft connections.
4. **Encryption at rest uses AES-GCM keyed by a Workers secret.** `MCP_ENCRYPTION_KEY`
   is a base64url 32-byte value sourced from `env` (never the DB, never the
   source). The same key is reused for HMAC state signing via a domain-separated
   prefix (`mcp-oauth-state::`). This matches the brief's "encryption keys must
   be configured in environment secrets". A new key requires re-encryption
   (out-of-scope tooling not built here — see "Unverified" #4).
5. **Disconnect hard-deletes the row.** Tokens are revoked upstream (best
   effort, `revokeToken` failures are swallowed), then the row is deleted to
   guarantee secrets are purged locally. There is no "soft delete" tombstone —
   the unique `(user_id, server_url)` constraint would otherwise block
   reconnect. This means disconnect is destructive and irreversible, which the
   UI's confirm dialog states explicitly.
6. **OAuth state carries everything needed to complete the flow.** No
   server-side session store is used for OAuth. State = HMAC-signed JSON of
   `{ serverId, userId, codeVerifier, expiresAt, nonce }`, encoded
   base64url-payload.hex-signature. CSRF resistance comes from the signed,
   short-lived (10 min) state; the `userId` inside the state is cross-checked
   against the session user on the callback to prevent swapped/forged states.
7. **PKCE S256 is mandatory.** `beginConnection` rejects metadata that
   advertises `code_challenge_methods_supported` without `S256`. We do not
   downgrade to `plain`. Servers that do not advertise the field at all are
   allowed (older servers); the spec-compliant S256 challenge is sent anyway.
8. **Dynamic Client Registration is optional but preferred.** When the
   authorization-server metadata exposes a `registration_endpoint`, we register
   a public client (RFC 7591, `token_endpoint_auth_method: "none"`). If DCR is
   unsupported or fails, we fall back to the static `client_id=mcp-client`
   (allowed by the MCP spec, which recommends Public clients use the literal
   `"mcp-client"`). Registered client secrets are stored encrypted.
9. **Discovery order follows the MCP authorization spec.** We fetch
   `/.well-known/oauth-protected-resource` first (to learn
   `authorization_servers`), then `/.well-known/oauth-authorization-server`
   (RFC 8414) on each candidate AS. If the protected-resource doc is missing
   (older MCP servers), we fall back to discovering on the server origin. Only
   the first 3 advertised authorization servers are tried.
10. **SSRF / unsafe redirect protection is enforced on every hop.** All
    outbound requests (discovery, token exchange, revocation, MCP `initialize`
    probe) go through `validateMcpServerUrl` and fetch with `redirect: "manual"`.
    Redirects are re-validated via `validateRedirect` so a metadata or token
    response cannot redirect us to a private/loopback address. Embedded URL
    credentials are rejected on input and on `authorization_endpoint`.
11. **`http` only for loopback in dev.** `http` is permitted exclusively for
    loopback hosts and only when `BETTER_AUTH_URL` itself starts with `http://`
    (local dev). This lets `http://localhost:3001` MCP servers work in dev
    without weakening the production https-only rule.
12. **Private RFC 1918 / RFC 6598 / link-local / unique-local / loopback
    addresses are rejected** except the loopback case in #11. Loopback is
    allowed because it is the common local-dev case and has no SSRF benefit for
    a Worker (the request originates from a Cloudflare colo, so it cannot reach
    the user's loopback anyway). The IPv4 ranges use integer masking (not naive
    prefix matching) — see `PRIVATE_IPV4_RANGES` in `url.server.ts`.
13. **Errors are sanitized.** `discovery.server` / `client.server` never echo
    upstream response bodies, headers, or raw network error text. They surface
    `ApiError` with generic messages ("MCP authorization server rejected the
    request", "Unable to reach MCP server"). The only structured upstream
    value surfaced is the RFC 6749 `error` code from a token endpoint failure,
    e.g. `MCP authorization error: invalid_grant`. Persisted `last_error` is
    truncated to 200 chars and contains only these sanitized messages.
14. **Tokens never reach the client.** `McpServerView` (the only MCP shape the
    API returns) deliberately omits `authDataEncrypted`, the decrypted auth
    blob, and any client secret. `discoveryMeta` only contains non-sensitive,
    server-authored fields (name, description, icon_uri, scopes). Tests
    explicitly assert that neither the raw DB column nor the JSON view contain
    token substrings.
15. **Edit changing the URL forces a reconnect.** Changing `serverUrl` invalidates
    the stored tokens (they are bound to a different server), so `editServer`
    nulls `auth_data_encrypted` + `discovery_meta` and flips status to
    `pending`. The card then surfaces a Reconnect action. Renaming-only edits
    keep status.
16. **OAuth callback is a 302 redirect back to `/dashboard?mcp=connected`.** The
    callback handler is `sameOrigin: false` (the request comes from the external
    MCP authorization server), unlike the other mutation handlers which are
    `sameOrigin: true`. The redirect target origin is derived from the request
    URL's own origin (`getOrigin` with `requireSameOrigin=false`), so a crafted
    callback cannot redirect to an arbitrary host.
17. **UI uses existing primitives and patterns.** No new design system pieces
    were added — `Card`, `Button`, `Badge`, `Dialog`, `Input`, `Label`,
    `Skeleton` (all from `components/ui`) plus `@tabler/icons-react` and
    `tw-animate-css` (`animate-in fade-in-0 slide-in-from-*`) micro-animations.
    State is managed with `useState`/`useEffect`/`fetch` exactly like the
    existing `/billing` page (the project wires TanStack Query but the billing
    UI does not use it for its page view).
18. **All five required lifecycle states are present.** Cards render distinctly
    for `pending` (pulsing dot + Authorize), `active` (Test + Edit +
    Disconnect), `error` (Reconnect + last error strip), and `disconnect` (via
    the confirm dialog). Reconnect re-runs discovery and starts a fresh OAuth
    flow on the same row. Edit and Disconnect dialogs are modal.
19. **DB migration is added but not auto-applied.** `drizzle/0002_faithful_kingpin.sql`
    is generated and committed. Per the brief, it is not run automatically;
    operators apply with `pnpm db:migrate` (local) or `pnpm db:migrate:prod`.
20. **The Pro entitlement name is `unlimited_mcp_servers`** (added to
    `subscriptionPlans.pro_monthly.entitlements`). This keeps MCP gating inside
    the existing entitlement system; it does not add a new billing-tier concept.

## Security invariants (enforced and tested)

- Encryption key lives only in `MCP_ENCRYPTION_KEY` env secret (`.env.example`
  documents generation; production uses `wrangler secret put`).
- No `console.log` of tokens, headers, or upstream bodies. `handleApiError` only
  logs unexpected non-`ApiError` errors with the message string (which we keep
  sanitized).
- Ownership: every mutation queries `userId` alongside the id; a missing/other
  user's row returns 404 indistinguishable from "not found".
- CSRF / unsafe redirect: signed state + `sameOrigin: true` mutation handlers +
  re-validated redirect targets.
- SSRF: scheme/credential/private-host re-validation on every outbound hop.

## Tests

`src/lib/mcp/__tests__/`:

- `url.server.test.ts` — scheme rules, SSRF rejection, redirect re-validation,
  credential-in-URL rejection, IPv4/IPv6 private blocks.
- `crypto.server.test.ts` — AES-GCM round trip, tamper detection, wrong-key
  rejection, key-length validation.
- `state.server.test.ts` — sign/verify round trip, tampered signature,
  cross-key rejection, expiry, malformed tokens.
- `entitlements.server.test.ts` — the 3-server free limit, Pro unlimited, 402
  `McpLimitError`, defensive negative counts.
- `oauth.server.test.ts` — PKCE S256 shape & uniqueness, authorization URL
  params, scope sanitization, credential-in-endpoint rejection.
- `core.server.test.ts` — end-to-end domain logic on an in-memory
  better-sqlite3 drizzle instance with mocked network/ids:
  - 3-server free limit (allows 3, blocks the 4th with 402).
  - Pro users unlimited (seeds active `pro_monthly` subscription rows via D1).
  - Tokens encrypted at rest (raw DB + JSON view do not contain token values).
  - Ownership: cross-user operations 404; cross-user OAuth callback 403.
  - Disconnect purges the row and invokes revocation.
  - `test()` flips status to `error` and records a sanitized `last_error`.
  - Editing the URL resets status to `pending` and clears tokens.
  - Duplicate `(user, url)` returns 409.

51 tests total; `vp check` (lint + typecheck) and `vp test` both pass.

## Items that could not be fully verified

1. **MCP authorization specification conformance.** I followed the published
   MCP authorization behavior (OAuth 2.0 Protected Resource Metadata +
   Authorization Server Metadata + dynamic client registration with
   `token_endpoint_auth_method: "none"` and the `"mcp-client"` literal for
   public clients). I did not have a live MCP server to validate end-to-end
   against; discovery / token exchange / probe are exercised via mocks.
2. **MCP `initialize` probe shape.** `probeMcpServer` sends a JSON-RPC
   `initialize` over HTTPS POST with `mcp-protocol-version: 2025-06-18` and
   treats `2xx` as success. The exact success response (single JSON-RPC reply
   vs. SSE stream) depends on the server transport; probing yields "ok" for any
   `2xx` even if the body is a stream, because the goal is just to confirm the
   stored bearer is still accepted (the strict protocol handshake is out of
   scope for the "test connectivity" feature).
3. **Refresh-token flow.** The `McpAuthData` schema stores `refreshToken` /
   `expiresAt` / `tokenEndpoint`, but no automatic refresh is implemented — the
   plan is to surface a "Reconnect" path when the access token stops working
   (the `test` action will flip status to `error`). Implementing proactive
   refresh would require either a background queue job or a lazy refresh inside
   the chat-session path, which does not yet exist in this codebase.
4. **Key rotation / re-encryption tooling.** If `MCP_ENCRYPTION_KEY` is rotated,
   existing rows cannot be decrypted. There is no migration script here. In
   production a worker would re-encrypt rows during rotation (decrypt with old
   key via env slot, encrypt with new key). Documented for completeness.
5. **Token revocation semantics.** `revokeToken` is best-effort; we ignore
   failures and always delete the local row. Some MCP authorization servers do
   not implement `revocation_endpoint`; in that case the upstream tokens remain
   valid until they expire and the user must revoke them manually at the
   server. We cannot do better without per-server guarantees.
6. **Per-user rate limiting on the connect endpoint.** Discovery is networked
   and could be abused as an amplification vector, but the existing project has
   no rate-limiting middleware to reuse, so no rate limit was added here. The
   3-server limit bounds the number of _successful_ discoveries per free user;
   the 3-server limit + same-origin handler + authenticated route mitigate the
   most obvious abuse. Cloudflare WAF/rate-limiting rules would be the natural
   place to add network-level protection.
7. **Screenshots.** The "nice to have" screenshot step requires running the
   app against a live MCP server and a configured `MCP_ENCRYPTION_KEY`/Stripe
   env. That was not available in this environment, so screenshots were not
   captured. The UI is exercised by following the existing `/billing` patterns
   and passes lint/typecheck/build.

## Operational setup (quick start)

```bash
# 1. Encryption key (32 bytes, base64url) — put in .dev.vars / wrangler secret
node -e "console.log(crypto.randomBytes(32).toString('base64url'))"
wrangler secret put MCP_ENCRYPTION_KEY

# 2. Apply the migration (NOT auto-run; brief requirement)
pnpm db:migrate            # local D1
pnpm db:migrate:prod       # remote D1

# 3. Run
pnpm dev
```

Free users can connect 3 MCP servers; Pro users (with an active
`pro_monthly` subscription) get unlimited connections. The entitlement is
enforced server-side using the existing billing/entitlement system.
