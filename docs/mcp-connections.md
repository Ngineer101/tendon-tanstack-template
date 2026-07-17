# MCP server connections

## What was implemented

The authenticated dashboard now lists user-owned remote MCP servers and supports connect, OAuth
authorization, reconnect, edit, test, and disconnect flows. Free users can configure three servers;
users with the existing `unlimited_mcp_servers` Pro entitlement are not capped.

The server-side MCP client performs protected-resource discovery, OAuth authorization-server
metadata discovery, PKCE (`S256`), OAuth resource indicators, Client ID Metadata Documents when
advertised, and Dynamic Client Registration as a fallback. OAuth tokens, refresh tokens, PKCE
verifiers, client secrets, and client-registration data are encrypted with AES-256-GCM before being
written to D1. The encryption additional authenticated data includes the owning user and connection,
so ciphertext cannot be moved between records.

Protocol behavior follows the MCP
[2025-11-25 authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
[OAuth Protected Resource Metadata (RFC 9728)](https://datatracker.ietf.org/doc/html/rfc9728), and
Cloudflare's current [Workers request handling and security guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

`mcpFetchForUser` in `src/lib/mcp/core.server.ts` is the server-only integration point for chat
sessions. It checks ownership and connection state, refreshes expiring OAuth credentials, strips
ambient cookie/proxy credentials, adds the bearer token server-side, and applies the outbound URL
policy. Tokens are never included in dashboard/API DTOs.

## Required operator setup

1. Generate a 32-byte encryption key and encode it as base64url (without padding).
2. Put it in `.env.local` as `MCP_CREDENTIALS_ENCRYPTION_KEY` for local development.
3. Add it to the deployed Worker as an environment secret:

   ```sh
   pnpm exec wrangler secret put MCP_CREDENTIALS_ENCRYPTION_KEY
   ```

4. Review `drizzle/0002_opposite_ezekiel_stane.sql` and apply it through the project's normal
   release process. The migration was generated but deliberately not applied.
5. Make sure the deployed app has a stable HTTPS origin. That origin is used for the OAuth callback
   and Client ID Metadata Document URLs.

## API surface

- `GET/POST /api/mcp/connections`
- `PATCH/DELETE /api/mcp/connections/:id`
- `POST /api/mcp/connections/:id/test`
- `POST /api/mcp/connections/:id/oauth/start`
- `GET /api/mcp/oauth/callback`
- `GET /api/mcp/oauth/client-metadata`

All mutations require the existing authenticated session and same-origin validation. The OAuth
callback requires the same authenticated browser session and a one-time, short-lived, hashed state
value bound to that user.

## Security controls

- The free-tier limit is enforced by one conditional D1 `INSERT`, not by the UI.
- Every record lookup includes the authenticated user ID. Cross-user IDs return the same 404 as
  missing IDs.
- Credentials use AES-256-GCM with a key sourced only from an environment secret.
- OAuth uses PKCE `S256`; providers that do not advertise it are rejected.
- The OAuth `resource` parameter is included in authorization, code exchange, and refresh requests.
- Only public HTTPS URLs on port 443 are accepted. User info, fragments, single-label hostnames,
  localhost/private/reserved literal IPs, and local-use DNS suffixes are rejected.
- Outbound redirects are manual, limited, validated at each hop, and constrained to the original
  origin. Token and registration requests do not follow redirects.
- Upstream JSON bodies and local API request bodies are size-limited before parsing.
- Provider response bodies, authorization codes, tokens, and client secrets are never logged.
- Dashboard responses contain connection metadata only; encrypted credentials never cross the
  server boundary.

## Micro-decisions and assumptions

- A "configured server" includes pending and errored records, not only currently healthy records.
  This prevents bypassing the free limit by repeatedly creating failed handshakes. The user can edit
  or disconnect one to free capacity.
- Pro is the paying tier in the existing billing model. The new capability is represented as the
  `unlimited_mcp_servers` entitlement on that plan rather than adding a second billing check.
- The atomic insert receives the entitlement decision as a parameter. This prevents concurrent free
  requests from inserting a fourth connection while keeping Stripe/subscription logic centralized.
- Server names are user-defined, trimmed, and limited to 80 characters. URLs are limited to 2,048
  characters.
- Query strings are removed from configured MCP URLs to avoid persisting credentials or unstable
  session material accidentally supplied in a URL. Endpoint paths and trailing-slash semantics are
  otherwise preserved.
- Port 443 is intentionally required. This is stricter than generic MCP and trades custom-port
  compatibility for a smaller SSRF surface in a multi-tenant product.
- Public MCP endpoints are supported. A successful unauthenticated MCP initialize probe marks the
  connection as `authType: none`; no credential record is created.
- For OAuth-protected servers, the first advertised authorization server is selected. A future UI can
  offer a choice if multi-issuer servers become common.
- The resource metadata's resource origin must match the configured MCP origin. Authorization and
  token endpoints may use a different public HTTPS origin because hosted identity providers commonly
  do so.
- Client ID Metadata Documents are preferred when advertised. Dynamic Client Registration is the
  fallback. Manually entering a client ID/secret was excluded to avoid adding a secret-bearing browser
  form and because the current MCP flow provides automatic mechanisms.
- Dynamic registration requests a public client (`token_endpoint_auth_method: none`). If the server
  returns a secret and a supported secret method, that secret is accepted and immediately encrypted.
- OAuth sessions expire after ten minutes and are consumed before code exchange, preventing replay.
  A transient token endpoint failure therefore requires reconnecting rather than replaying a callback.
- Expired OAuth handshake rows are removed by the existing 15-minute scheduled Worker trigger.
- Editing only a display name preserves authorization. Changing the URL clears the old encrypted
  credentials and immediately repeats discovery/authorization.
- Reconnect leaves an existing credential usable until the new OAuth callback succeeds, but the card
  is shown as pending during the new handshake. A failed reconnect moves it to an attention state.
- A connection test uses the MCP `initialize` method with protocol version `2025-11-25`. It treats any
  2xx response as transport success and cancels the response body because tool discovery is outside
  the dashboard test's scope.
- Expiring access tokens are refreshed 30 seconds early. Refresh-token rotation is persisted
  atomically with the new access token.
- Disconnect permanently removes the local connection and encrypted credentials. The current MCP
  authorization metadata does not require a revocation endpoint, so remote grant revocation is not
  assumed; users can revoke the application at the provider if needed.
- Error records store stable error codes, not provider response bodies. This gives useful UI feedback
  without persisting potentially sensitive upstream content.
- Motion is limited to card entrance, status/progress feedback, and small interaction transitions,
  and it is disabled under `prefers-reduced-motion`.
- OAuth success/error feedback is passed back to the dashboard using a fixed local redirect and a
  short error code. No provider-controlled redirect is accepted.

## What could not be fully verified

- No real third-party MCP OAuth provider, client registration endpoint, or token endpoint credentials
  are included in this template, so the complete external consent exchange was verified structurally
  and with unit tests, not against a live provider.
- Cloudflare Workers' public `fetch` network supplies an additional network boundary, but application
  code cannot synchronously pin and re-check DNS answers. The implementation blocks private/reserved
  literal addresses and unsafe hostnames and validates every redirect; a dedicated outbound proxy with
  DNS/IP inspection would be needed for independently verifiable DNS-rebinding protection.
- The repository does not currently contain chat routes or a chat execution loop. The authenticated
  server-side `mcpFetchForUser` integration is implemented and ready for that loop, but no absent chat
  subsystem could be wired or exercised.
- The migration was not applied, per request, so local browser testing that persists MCP records needs
  an operator-applied local migration first.
- Live OAuth behavior varies across providers, particularly older pre-registration-only servers. This
  implementation follows the current MCP automatic registration order and reports an actionable error
  for servers that support neither Client ID Metadata Documents nor Dynamic Client Registration.
