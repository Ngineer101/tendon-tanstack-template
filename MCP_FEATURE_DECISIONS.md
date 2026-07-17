# MCP Server Connection Feature - Micro-decisions

## Architecture Decisions

### 1. Encryption: AES-256-GCM via Web Crypto API

**Decision**: Use AES-256-GCM with a key derived from `MCP_ENCRYPTION_KEY` environment variable via SHA-256 digest.
**Rationale**: Web Crypto API is natively available in Cloudflare Workers. AES-GCM provides authenticated encryption (confidentiality + integrity). The env secret is hashed to produce a fixed-length 256-bit key regardless of input length.
**Alternatives considered**: Sodium/libsodium bindings were avoided to keep zero native dependencies for Cloudflare Workers compatibility.

### 2. SSRF Protection: Hostname allowlist (block by default)

**Decision**: Validate URLs at creation/edit time against a blocklist of private/reserved IP ranges, localhost, and link-local addresses. Only HTTPS is allowed.
**Rationale**: URL validation is the simplest reliable defense against SSRF in a Worker environment. DNS rebinding attacks are mitigated by the Workers runtime's DNS caching. Inline credentials in URLs are rejected.

### 3. OAuth Flow: Authorization Code with PKCE

**Decision**: Use OAuth 2.0 Authorization Code flow with PKCE (S256). The `exchangeCodeForTokens` function accepts a minimal interface `{tokenEndpoint, clientId, codeVerifier}` rather than the full `OAuthState` to avoid storing unnecessary state.
**Rationale**: PKCE is the OAuth 2.1 recommended approach for public clients. S256 challenge method provides strong protection against authorization code interception.

### 4. OAuth Discovery: Multiple well-known paths

**Decision**: Try `/.well-known/openid-configuration` first, then `/.well-known/oauth-authorization-server` (MCP-specific).
**Rationale**: Maximizes compatibility with both standard OAuth 2.0 servers and MCP-specific OAuth servers. Both standards are in use.

### 5. OAuth Callback: Public (unauthenticated) handler

**Decision**: The OAuth callback endpoint uses `publicApiHandler` rather than `authenticatedApiHandler` because the callback request originates from the user's browser after the MCP server redirects them. CSRF protection is handled by validating the `state` parameter against the stored value.
**Rationale**: The redirect may not carry session cookies reliably across all MCP providers. The state parameter (a random nonce generated per-auth-attempt and stored in the DB) provides equivalent CSRF protection.

### 6. Server Limit Enforcement: Server-side with billing integration

**Decision**: The 3-server free limit is enforced server-side in `checkServerLimit()` by counting existing servers and checking the user's billing plan via `getBillingSummary()`. Pro users (with `unlimited_mcp_servers` entitlement) bypass the limit.
**Rationale**: Client-side checks are trivially bypassable. The limit check integrates with the existing billing system and uses the same `getBillingSummary` pattern as the rest of the app.

### 7. Route Parameter Extraction: URL path parsing

**Decision**: Extract `$id` from route paths using regex matching on `request.url` rather than using `Route.$parseParams()`.
**Rationale**: `Route.$parseParams` is not available on server-side API handlers in the current version of TanStack Start. The regex approach is simple and safe since IDs are UUID-based.

### 8. Status Management: Connected/Disconnected/Error

**Decision**: Three-state model: `disconnected` (just created, no auth), `connected` (test passed or OAuth completed), `error` (test or OAuth flow failed).
**Rationale**: Simple state machine that covers all UX requirements. Users can reconnect from error state.

### 9. Test Connection: Health endpoint probe

**Decision**: Test connectivity by fetching `{serverUrl}/health` with a 5-second timeout. HTTP 401 is considered a "connected" response (auth required but server is reachable).
**Rationale**: A dedicated health endpoint is the simplest way to verify connectivity without needing MCP protocol-specific handshakes. Accepting 401 avoids false negatives for OAuth-protected servers.

### 10. Frontend State: React useState in section component

**Decision**: Manage MCP server list in a local `useState` within `McpServerSection` rather than TanStack Query.
**Rationale**: The server list is only needed on the dashboard page and is primarily CRUD operations. React Query would add complexity for minimal benefit given the scope. Can be migrated to React Query later if caching becomes important.

### 11. Icons: @tabler/icons-react

**Decision**: Used `@tabler/icons-react` for MCP UI components since it's already a dependency of the project.
**Rationale**: Consistency with existing codebase dependencies. All icons used have clear semantic meaning.

### 12. Testing: Pure-function tests with Vitest

**Decision**: Test pure-domain logic (validation, encryption, OAuth primitives) in isolation. DB-dependent integration tests deferred to e2e/integration suite.
**Rationale**: `core.server.ts` functions depend on D1 (Cloudflare Workers D1Database) which cannot be instantiated outside the Workers runtime. Unit tests validate the pure functions (URL validation, encryption round-trips, label validation, public serialization) that are the foundation of the domain logic.

## Assumptions

1. **MCP servers expose a `/health` endpoint**: The test connection feature assumes servers have a reachable health endpoint. If a server doesn't have one, the test will report an error, and the user will need to trust the "connected" status from OAuth.
2. **OAuth providers return JSON token responses**: The token exchange assumes the standard OAuth 2.0 JSON response format with `access_token`, `refresh_token`, and `expires_in`.
3. **No refresh token rotation**: The current implementation decrypts the stored token for each connection test but does not perform proactive refresh token rotation. If a refresh token expires, the user would need to re-authenticate.
4. **Single OAuth provider per server**: Each server supports exactly one OAuth flow (re-initiation clears previous tokens).
5. **BETTER_AUTH_URL is used as the OAuth client_id**: We use the app's URL as the client identifier with MCP servers, with the server_id appended as a query parameter in the redirect URI.

## Unverified Items

1. **End-to-end OAuth flow with a real MCP server**: The OAuth discovery, authorization, and token exchange code has been written but not tested against a real MCP server implementing the OAuth spec. Manual testing with a live MCP server is needed.
2. **Database migration**: The SQL migration file has been created but not applied. Run `pnpm db:migrate` to apply.
3. **MCP_ENCRYPTION_KEY generation**: The encryption key must be generated and set in the environment before the feature can be used in production. Generate with `openssl rand -base64 32`.
4. **Refresh token flow**: The refresh token logic exists in `oauth.ts` but is not wired into the connection test or any automatic refresh mechanism.
5. **Tailwind CSS animation classes**: The `animate-in`, `fade-in-0`, `slide-in-from-bottom-*`, `zoom-in-95` classes are from `tw-animate-css` which is already in the project's dependencies. These were used based on the assumption they work with Tailwind v4.
6. **API handler tests (authenticatedApiHandler/publicApiHandler)**: `api.ts` imports `cloudflare:workers` which is only available in the Workers runtime. Unit tests for the handler wrappers require a Workers-compatible test environment (e.g., `unstable_dev` or Miniflare). Skipped in favor of pure-domain logic tests.
7. **DB integration tests**: Drizzle queries against D1 cannot be tested in vitest's Node environment. Integration tests should use `wrangler dev --test` or Miniflare with a local D1 binding.

## Security Considerations

- **Encryption key management**: The `MCP_ENCRYPTION_KEY` must be set as a Cloudflare secret (`wrangler secret put MCP_ENCRYPTION_KEY`). It should never be committed to source control.
- **OAuth state validation**: The `state` parameter is validated server-side to prevent CSRF attacks on the callback endpoint.
- **Credential logging**: The encryption utility ensures OAuth tokens are never logged or exposed in plaintext. The API response for listing servers never includes encrypted data.
- **Same-origin protection**: All mutating API endpoints require `sameOrigin: true` which validates the `Origin` header matches the request URL.
