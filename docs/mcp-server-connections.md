# MCP Server Connections

Users can connect [Model Context Protocol](https://modelcontextprotocol.io) servers from the
dashboard (`/dashboard`) so chat features can call their tools. Free accounts are limited to
**3 servers**; the Pro subscription lifts the cap via the `unlimited_mcp_servers` entitlement.

## Setup

1. Apply the database migration (`drizzle/0002_useful_the_renegades.sql`):

   ```bash
   pnpm run db:migrate        # local
   pnpm run db:migrate:prod   # production
   ```

2. Configure the encryption key as an environment secret (never in the DB or source):

   ```bash
   openssl rand -base64 32    # generate
   # local: add MCP_ENCRYPTION_KEY=<value> to .dev.vars
   pnpm exec wrangler secret put MCP_ENCRYPTION_KEY   # production
   ```

## How it works

### Connect flow

1. User submits a server URL (`POST /api/mcp/servers`).
2. The server URL is validated (HTTPS-only for public hosts, no embedded credentials, no
   private IP literals) and the per-plan limit is enforced server-side via
   `hasEntitlement(env, userId, "unlimited_mcp_servers")` before any network call.
3. The worker probes the endpoint with an unauthenticated MCP `initialize` handshake
   (Streamable HTTP transport, JSON or SSE responses):
   - **Handshake succeeds** → the row is stored as `connected` with `auth_type = "none"`,
     server info and tool count.
   - **401** → OAuth discovery per the MCP authorization spec:
     RFC 9728 protected-resource metadata (honoring the `WWW-Authenticate:
resource_metadata` parameter) → RFC 8414 / OIDC authorization-server metadata →
     MCP-spec default endpoints (`/authorize`, `/token`, `/register`) as fallback.
     Then RFC 7591 dynamic client registration (public client), and the row is stored as
     `pending_auth` with the registration encrypted in `encrypted_auth_data`.
4. The user is redirected to the authorization server (PKCE S256, `state`, RFC 8707
   `resource` indicator). `state` and the PKCE verifier live in the single-use, 10-minute
   `mcp_oauth_session` table; the verifier is encrypted.
5. `GET /api/mcp/oauth/callback` validates the session + state (bound to the initiating
   user), exchanges the code, encrypts and stores the token set, runs the handshake with
   the new token, and redirects back to `/dashboard?mcp=connected|cancelled|error`.

### Lifecycle states

| Status         | Meaning                                         | Available actions                 |
| -------------- | ----------------------------------------------- | --------------------------------- |
| `pending_auth` | OAuth started but not completed                 | Finish setup, edit, disconnect    |
| `connected`    | Handshake (with valid auth, if any) succeeded   | Test, edit, disconnect            |
| `error`        | Last connectivity test failed                   | Test, reconnect, edit, disconnect |
| `auth_expired` | Refresh token rejected or 401 with stored token | Reconnect, edit, disconnect       |

- **Test** (`POST /api/mcp/servers/:id/test`) refreshes expiring access tokens (rotated
  tokens are re-encrypted and persisted) and re-runs the handshake.
- **Reconnect** (`POST /api/mcp/servers/:id/reconnect`) starts a fresh OAuth grant, reusing
  the stored client registration when the authorization server is unchanged. Existing
  tokens are kept until the new grant completes, so a cancelled reconnect does not break a
  working connection.
- **Edit** (`PATCH /api/mcp/servers/:id`) updates the name in place; a URL change
  re-validates, re-probes, and restarts OAuth when required.
- **Disconnect** (`DELETE /api/mcp/servers/:id`) hard-deletes the row (OAuth sessions
  cascade).

### Security properties

- Auth data (client id/secret, access/refresh tokens, expiry, scope, endpoints) is
  encrypted with AES-256-GCM using `MCP_ENCRYPTION_KEY` (env secret), format
  `v1.<iv>.<ciphertext>` (base64url). The version prefix allows future key rotation.
- Only `toPublicServer()` output ever reaches the browser; it has no credential fields.
- SSRF: URL policy above + manual redirect following with per-hop re-validation
  (`safeFetch`), no credentials forwarded across redirects, 10s timeouts, 64KB response
  caps.
- Logs/errors: upstream response bodies (which can contain tokens) are never logged or
  propagated; provider `error_description` values are mapped to fixed messages.
- API mutations require a better-auth session + same-origin `Origin` header; resource
  ownership is enforced with 404s (no existence leaks).
- The limit is checked before insert. Concurrent requests can theoretically race the
  count check; D1 cannot serialize this without a stronger constraint, and the impact is
  bounded to a small over-allocation (documented, accepted).

## Micro-decisions & assumptions

1. **Hard delete on disconnect.** Simpler uniqueness + limit accounting; reconnecting a
   deleted server just means adding it again.
2. **Entitlement over plan string.** Added `unlimited_mcp_servers` to the Pro plan's
   entitlements in `src/lib/billing/config.ts` instead of special-casing `plan ===
"pro_monthly"` in feature code, matching the billing README's guidance.
3. **Limit races are tolerated** (see above) rather than introducing a counter table.
4. **HTTP allowed for loopback only** (`localhost`, `127.0.0.0/8`, `::1`) so developers can
   connect local servers; everything else must be HTTPS. Workers cannot reach private
   networks anyway, but literal private IPs are still rejected for defense in depth.
5. **No DNS-rebinding protection.** Workers cannot resolve-and-pin hostnames; documented
   limitation. The remaining risk is a public hostname resolving to internal services —
   mitigated by HTTPS + the response caps, accepted for this template.
6. **Dynamic client registration is required** for OAuth servers. Servers without a
   registration endpoint surface a clear error instead of falling back to a shared client
   id (which would be a secret-management problem of its own).
7. **Public OAuth client** (`token_endpoint_auth_method: "none"`); a client secret is used
   only if the AS chooses to issue one.
8. **Best-effort `tools/list`.** Some servers require full session semantics; a failed
   tools call never fails the connection — `toolCount` stays `null`.
9. **Protocol version `2025-06-18`** is offered at initialize; servers negotiate per spec.
10. **Probing before persisting.** Unreachable servers fail the request with a 502 rather
    than creating a dead row. OAuth servers are the exception: the `pending_auth` row must
    exist so the callback (and the OAuth session FK) has something to attach to.
11. **Redirect same-tab** (like Stripe checkout) instead of a popup — popup blockers make
    popup OAuth unreliable; the callback restores context via dashboard banners.
12. **Single-use state rows, consumed on any callback** (success, error, or denial), with a
    10-minute TTL and lazy cleanup.
13. **Tokens refreshed lazily** at test/usage time with a 60s skew; no background cron
    refresh (a `pruneExpiredOauthSessions` helper is exported for the existing cron
    plumbing if desired).
14. **UI fetches billing summary separately**; if it fails, the usage badge degrades to
    hiding the limit (server still enforces).
15. **Chat integration is a server-side seam**: `getMcpAccessToken(env, userId, serverId)`
    returns fresh credentials for chat features. No chat UI exists in this template, so no
    client wiring was added.

## Screenshots

Captured from a local dev run against a mock MCP server (`docs/screenshots/`):

- `mcp-dashboard-empty.png` — empty state with the connect CTA
- `mcp-connect-dialog.png` — connect form (URL + display name)
- `mcp-connect-success.png` — successful handshake, tool count reported
- `mcp-grid-statuses.png` — grid with `connected`, `error`, and `pending_auth` cards plus the free-plan limit tile
- `mcp-edit-dialog.png` — edit flow
- `mcp-disconnect-dialog.png` — disconnect confirmation

## Not fully verified

- **Real OAuth providers**: the flow is tested against mocked authorization servers that
  follow the specs, but not against a live provider (e.g. an actual Linear/GitHub MCP
  server). Redirect-based edge cases (provider-specific quirks, non-standard 4xx bodies)
  may need small follow-ups.
- **SSE-heavy servers**: `tools/list` over long-lived SSE streams is capped at 64KB and the
  first matching response; servers that stream progress before results are handled, but
  exotic framing was not tested against real implementations.
- **D1 foreign-key enforcement**: the test shim enforces FKs like production SQLite;
  migrations were generated but intentionally not applied anywhere.
- **Cloudflare Workers runtime**: tests run on Node's WebCrypto; `crypto.subtle` AES-GCM is
  available on Workers, but the exact workerd build was not exercised in CI.
