# MCP Server Management — Implementation Notes

## Micro-decisions and assumptions

### 1. Encryption scheme

- **Algorithm**: AES-256-GCM via the Web Crypto API (`crypto.subtle.encrypt/decrypt`).
- **Key source**: `MCP_ENCRYPTION_KEY` environment secret — a 32‑byte key encoded as base64. The server startup validates the key length.
- **IV**: 12 random bytes generated per encryption operation, prepended to the ciphertext in the stored blob.
- **Rationale**: Web Crypto is available in Cloudflare Workers natively. AES‑GCM provides authenticated encryption (confidentiality + integrity). No external crypto libraries required.

### 2. OAuth flow (PKCE)

- **Assumption**: The MCP server exposes OAuth 2.0 metadata at `{serverUrl}/.well-known/oauth-authorization-server`.
- **Flow**: Authorization Code with PKCE (S256).
- **State transport**: OAuth state + encrypted payload (code verifier, server ID, user ID) encoded in the `state` query parameter as `{uuid}.{encrypted_blob}`.
- **Callback**: `GET /api/mcp/oauth/callback` — a public endpoint that exchanges the code, encrypts/ stores tokens, and redirects to `/dashboard?mcp_connected=1` on success or `/dashboard?mcp_error=...` on failure.
- **Assumption**: The MCP server's token endpoint supports standard `application/x-www-form-urlencoded` POST body.
- **Client ID**: Uses the callback origin as the client ID, assuming dynamic client registration is not required.
- **Could not fully verify**: The exact OAuth metadata endpoint path (`.well-known/oauth-authorization-server`) follows RFC 8414 and the MCP draft spec. Some MCP implementations may use a different path; this can be made configurable.

### 3. SSRF protection

- Validated server-side in `validateServerUrl()`:
  - Rejects non-HTTP(S) protocols.
  - Rejects `localhost`, `.local` domains.
  - Rejects private IPv4 ranges (127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x).
  - Rejects `0.0.0.0` and multicast addresses.
  - Rejects known cloud metadata endpoints (`metadata.google.internal`).
- **Assumption**: IPv6 private ranges (`fc00::`, `fd00::`, `fe80::`) are covered by regex but not exhaustively tested against all IPv6 address formats.
- **Could not fully verify**: IPv6 binding to link-local addresses through hostname resolution. If the MCP server URL resolves to a private IP via DNS rebinding, the DNS resolution happens in Cloudflare's network which provides some protection, but this should be monitored.

### 4. Server limits

- **Free**: 3 MCP servers maximum.
- **Pro**: Unlimited (via `mcp_unlimited` entitlement added to `BILLING_CATALOG.subscriptionPlans.pro_monthly.entitlements`).
- **Enforcement**: Server-side in `checkServerLimit()` before every `createMCPServer()` call. Count is queried from DB.
- **Assumption**: Deleted servers free up a slot immediately.

### 5. Credential storage

- OAuth tokens are stored as an encrypted JSON blob in `mcp_server.encrypted_credentials`.
- Credentials are NEVER returned to the client — the API returns `hasCredentials: boolean` only.
- `getDecryptedCredentials()` is available server-side for use in chat sessions.

### 6. Database schema

- `mcp_server` table with columns: id, user_id (FK → user), name, server_url, status, encrypted_credentials, oauth_provider, last_tested_at, created_at, updated_at.
- Status values: `connected`, `disconnected`, `error`, `testing`.
- Migration: `drizzle/0002_flashy_redwing.sql`.

### 7. Testing approach

- **Connection test**: Sends a `tools/list` JSON‑RPC request to the MCP server (10s timeout). Updates status to `connected` or `error` with last test timestamp.
- **Assumption**: All MCP servers respond to `tools/list` at their base URL using JSON‑RPC. This is the standard MCP initialization pattern.

### 8. UI decisions

- **Empty state**: Dashed border container with server icon and CTA button.
- **Loading state**: 3 skeleton cards while data fetches.
- **Staggered animation**: Cards animate in with `80ms` delay increments using `animate-in` utility classes from `tw-animate-css`.
- **Status badges**: Color‑coded inline badges (connected = primary/green, disconnected = muted, error = destructive/red, testing = muted with spinner).
- **Card elevation**: Connected servers get a subtle gradient top border and shadow on hover.

### 9. API route structure

- `GET /api/mcp` — list all servers + limit info
- `POST /api/mcp` — create server
- `GET /api/mcp/$id` — get single server
- `PUT /api/mcp/$id` — update server
- `DELETE /api/mcp/$id` — delete server
- `POST /api/mcp/oauth/discover` — OAuth metadata discovery
- `POST /api/mcp/oauth/start` — initiate OAuth flow (returns auth URL)
- `GET /api/mcp/oauth/callback` — OAuth callback (public endpoint)
- `POST /api/mcp/test` — test connection

### 10. API authorization

- All mutation endpoints require `sameOrigin: true` to prevent CSRF.
- All endpoints use `authenticatedApiHandler` which verifies the better‑auth session.
- The OAuth callback is a `publicApiHandler` (no session) because it's called by the MCP server redirect; state validation with encrypted payload prevents tampering.

### 11. Error handling

- All errors propagate through `handleApiError()` with appropriate HTTP status codes.
- Client-side errors show in an animated error banner.
- OAuth callback errors redirect to `/dashboard?mcp_error=...` with a descriptive message.
- Toast notifications for success/failure on connect, test, disconnect, and delete.

### 12. Could not be fully verified

- **End‑to‑end OAuth flow**: Requires a real MCP server with OAuth support for testing. The PKCE implementation follows RFC 7636 but hasn't been tested against a compliant MCP authorization server.
- **Token refresh**: The credential model stores `refreshToken` but automatic token refresh is not implemented — it should be added when the credentials are used in chat sessions.
- **DNS rebinding protection**: The URL validation checks hostnames at request time but does not block DNS rebinding at the network level. Cloudflare's network provides some protection, but this should be monitored.
- **Rate limiting on discovery endpoints**: The OAuth discovery and token endpoints are not rate‑limited at the application level. Consider adding rate limiting in production.
- **OAuth metadata caching**: The OAuth metadata endpoint is fetched on every discovery call. No caching is implemented.
- **MCP server response format**: The `testConnection` function assumes JSON‑RPC 2.0 response format. Non‑compliant MCP servers may cause test failures.
