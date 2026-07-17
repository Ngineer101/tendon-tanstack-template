# MCP Server Connections

## Implementation Notes

- MCP connections are configured from `/dashboard` and persisted in `mcp_server`.
- OAuth callback state is persisted in `mcp_oauth_state` with a 10 minute expiry.
- Free users are limited to 3 active MCP servers. Pro users receive the `unlimited_mcp_servers` entitlement and are not capped.
- The limit is enforced in server-side domain logic before a new OAuth connection is started.
- OAuth token responses and transient PKCE verifiers are encrypted with AES-GCM before being stored.
- `MCP_AUTH_ENCRYPTION_KEY` must be supplied as an environment secret. It is not stored in the database or source.
- OAuth client configuration is read from `MCP_OAUTH_CLIENT_ID` and optional `MCP_OAUTH_CLIENT_SECRET`.
- Tokens are never returned from the API. Dashboard responses include only connection metadata and status fields.
- Server URLs must use HTTPS, cannot contain credentials, and reject obvious local/private/link-local hosts.
- OAuth discovery and token exchange use `redirect: "manual"` and fail on redirects to reduce unsafe redirect and credential-leak risk.
- The connection test sends the bearer token only to the configured MCP server URL and does not follow redirects.

## Micro-Decisions and Assumptions

- Pro billing is treated as the paying tier because the starter currently exposes `free` and `pro_monthly`.
- A new `unlimited_mcp_servers` entitlement was added to the existing Pro catalog entry instead of hard-coding plan names throughout the feature.
- Disconnected MCP servers remain visible in the grid for reconnect/edit history, but they are not counted toward the free-plan active connection limit.
- `pending_auth`, `needs_reconnect`, `connected`, and `error` count toward the free-plan limit because they represent configured server slots.
- Editing a connected server's URL clears stored auth data and changes the state to `needs_reconnect`.
- Editing only the display name keeps the existing connection state and encrypted auth data.
- OAuth discovery checks authorization server metadata at `/.well-known/oauth-authorization-server` first, then `/.well-known/openid-configuration`.
- Dynamic OAuth client registration was not implemented; this app expects OAuth client credentials to be configured through environment secrets.
- The test action treats HTTP 2xx, 405, and 406 as reachable because MCP HTTP servers may reject GET while still confirming that the endpoint and auth path are reachable.
- The UI uses the project’s existing card, badge, button, dialog, label, and input primitives rather than adding new component dependencies.
- Micro animations are implemented with existing Tailwind/tw-animate classes and transitions: dialog reveal, discovery reveal, card lift, icon rotation, and loading spinners.
- API errors are returned as user-safe messages. Secret-bearing OAuth responses are not included in thrown errors or logs.

## Not Fully Verified

- End-to-end OAuth authorization against a real third-party MCP server was not verified because no provider-specific OAuth client credentials or test MCP provider were available in this workspace.
- DNS rebinding or hostname-to-private-IP resolution cannot be fully prevented without a resolver layer. The implementation blocks private IP literals and common local hostnames, and documents that production deployments should keep outbound egress controls in place.
- MCP tool invocation from chat sessions is not present in this starter app, so this work stores encrypted credentials and connection metadata for future chat usage but does not wire a non-existent chat runtime.
- `MCP_AUTH_ENCRYPTION_KEY`, `MCP_OAUTH_CLIENT_ID`, and optional `MCP_OAUTH_CLIENT_SECRET` must be configured in the target environment before the OAuth flow can complete.
- The generated migration was created but not applied, per the instruction not to run DB migrations automatically.
- A live screenshot artifact was not produced. The protected dashboard requires local auth plus the new unapplied D1 migration, and Playwright is not installed as a direct project dependency for an isolated static capture.

## Validation Performed

- `vp install`
- `vp check`
- `vp test`
- `vp build`
