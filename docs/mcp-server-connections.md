# MCP Server Connections

## Implementation Notes

- MCP connections are stored in `mcp_server_connection`; short-lived OAuth handshakes are stored in `mcp_oauth_state`.
- Free users are limited to 3 non-disconnected MCP servers. Pro users inherit unlimited connections through the existing billing summary plan check.
- Server limits are enforced in `src/lib/mcp/core.server.ts`, not in the browser.
- OAuth uses discovery plus authorization-code PKCE. Dynamic client registration is used when the MCP authorization server advertises `registration_endpoint`.
- If a server does not support dynamic client registration, the application expects `MCP_OAUTH_CLIENT_ID` and optional `MCP_OAUTH_CLIENT_SECRET` as server-side environment secrets.
- Auth payloads are encrypted with AES-GCM before storage. The encryption key is read from `MCP_AUTH_ENCRYPTION_KEY`; it is not stored in the database or source.
- The client only receives connection metadata: name, URL, status, issuer, scopes, and test state. It never receives access tokens, refresh tokens, client secrets, or encrypted auth blobs.
- SSRF protection requires HTTPS, blocks credentials in URLs, blocks localhost/internal/private IP literals, and requires public fully qualified hostnames.
- MCP server discovery and test requests use `redirect: "manual"` and reject redirect responses.
- OAuth callback completion requires the current Better Auth session to match the user attached to the OAuth state.
- Editing the server URL clears auth data and moves the connection to `needs_reconnect`.
- Disconnecting is soft-state: auth data is removed and status becomes `disconnected` so the dashboard can still show the connection history.
- Testing a server performs a server-side authenticated request to the stored MCP server URL and stores only a sanitized HTTP status error.

## Micro-Decisions and Assumptions

- A "connected server" for free-plan limits means any server whose status is not `disconnected`.
- Reconnecting an existing server does not consume an additional free-plan slot.
- The dashboard remains the first screen for this feature because `/dashboard` already exists and is protected.
- The UI uses the existing card, button, badge, input, and dialog components instead of introducing a new design system.
- The connect flow asks for scopes but defaults to `openid profile offline_access` for OAuth-compatible MCP servers.
- If a discovered authorization server publishes supported scopes, the implementation keeps requested scopes that are supported and falls back to the first requested scope if none match.
- Dynamic client registration stores a returned `client_secret` encrypted only long enough to complete the OAuth state flow.
- The unique user/server URL constraint intentionally prevents duplicate active records for the same user and URL; reconnecting the same URL updates the existing record.
- The OAuth callback redirects to `/dashboard` with short status messages for a smoother browser flow.
- The database migration was generated but not applied.

## Not Fully Verified

- Real-world MCP OAuth discovery varies by provider. This implementation supports `WWW-Authenticate` resource metadata, protected-resource metadata, OAuth authorization-server metadata, and OpenID configuration, but no live third-party MCP provider was available for full interoperability testing.
- DNS rebinding and hostname-to-private-IP resolution cannot be fully prevented in application code without network-layer egress controls. The code blocks private IP literals and internal hostnames, and Cloudflare/network policy should also restrict private egress.
- The dashboard screenshot could only be taken after running the app locally with a valid auth session and database state.
- The generated `worker-configuration.d.ts` was updated manually with MCP secret binding names. Running `vp run cf-typegen` after configuring secrets may rewrite that file.
