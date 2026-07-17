# MCP Server Connections

## What was implemented

- `/dashboard` lists every configured MCP server in a responsive grid and exposes connect, reconnect, edit, protocol-test, and disconnect states.
- The connection dialog guides the user through URL configuration, OAuth discovery, and authentication with progress, pending, success, and error feedback.
- Authenticated, same-origin APIs handle discovery and mutations. The OAuth callback is protected by a user-bound, single-use state record and PKCE.
- MCP OAuth discovery follows the current protected-resource flow: an MCP challenge or `/.well-known/oauth-protected-resource` locates the authorization server, then RFC 8414/OpenID Connect metadata locates its endpoints.
- Authorization and token requests include the MCP `resource` indicator. Supported token endpoint authentication methods determine whether the configured client is public, uses HTTP Basic, or uses `client_secret_post`.
- OAuth token responses and transient PKCE verifiers are encrypted with purpose-bound AES-256-GCM before D1 persistence. Tokens are never returned by dashboard APIs.
- Expiring access tokens are refreshed server-side when possible. A failed refresh moves the server to `needs_reconnect`.
- The test action sends a real MCP `initialize` JSON-RPC request and validates the bounded JSON or SSE response instead of treating generic HTTP reachability as success.
- `getConnectedMcpServersForChat` is the server-only integration point for a chat runtime. It authorizes by user, refreshes tokens when needed, and returns connection headers that must never be serialized to a browser.
- The migrations add `mcp_server`, `mcp_oauth_state`, lookup indexes, and the selected token authentication method. They were generated but not applied.

## Required environment secrets

- `MCP_AUTH_ENCRYPTION_KEY`: at least 32 bytes of high-entropy input; a base64-encoded 32-byte key is accepted directly. Configure it with the platform secret manager, never in source, Wrangler vars, or the database.
- `MCP_OAUTH_CLIENT_ID`: a client identifier registered with the MCP authorization server. It may be a URL when the provider supports OAuth Client ID Metadata Documents.
- `MCP_OAUTH_CLIENT_SECRET`: optional; required only for authorization servers that do not accept a public client.

Changing the encryption key without re-encrypting existing records makes stored credentials unreadable and requires users to reconnect.

## Security controls

- Every MCP API requires the existing Better Auth session. Mutation APIs additionally require an exact same-origin `Origin` header.
- Server ownership is checked on every read or mutation, and an unauthorized server ID returns `404` to avoid disclosing its existence.
- The three-server limit is claimed in one conditional D1 write. This keeps the server-side entitlement check effective under concurrent requests; Pro uses the existing `unlimited_mcp_servers` entitlement.
- Outbound URLs must use HTTPS, cannot contain URL credentials, and reject local/reserved hostnames and IP literals.
- Before every discovery, token, refresh, or MCP request, public DNS is resolved through Cloudflare DNS and every returned A/AAAA address is checked against private, loopback, link-local, carrier-grade NAT, documentation, and other reserved ranges.
- Outbound redirects are never followed. Authorization endpoint URLs are DNS-checked before being returned to the browser. Token-bearing requests therefore cannot redirect credentials to another host.
- Outbound requests have an eight-second timeout. Discovery, token, and initialize responses are capped at 64 KiB. MCP API request bodies are capped at 16 KiB.
- OAuth state expires after ten minutes and is atomically consumed before code exchange, preventing replay. Editing a URL or disconnecting invalidates outstanding states.
- Unexpected API exceptions are logged only by error class, not by message, stack, request body, headers, tokens, or OAuth responses.
- Disconnect removes local encrypted credentials. Editing a URL also clears credentials and requires reauthentication.

## Micro-decisions and assumptions

- `pro_monthly` is the paying tier because it is the only paid subscription in the existing billing catalog. Unlimited access is expressed as an entitlement rather than a plan-name check in MCP code.
- `connected`, `pending_auth`, `needs_reconnect`, and `error` consume a free slot because each represents a reserved configuration. `disconnected` records remain visible for history and reconnect UX but do not consume a slot.
- Reconnecting an already-active URL is allowed at the free limit; reconnecting a disconnected URL must claim a slot again.
- The first authorization server in protected-resource metadata is selected. The UI does not ask users to choose among multiple issuers.
- Protected-resource `resource` metadata must exactly match the normalized MCP server URL. This is intentionally strict to prevent authorization-server mix-up and token audience confusion.
- RFC 8414 path-insertion discovery is tried before OpenID Connect path-insertion and path-appending discovery for issuers containing a path.
- Dynamic Client Registration is not required by the current MCP specification, so this implementation uses environment-configured client credentials. It supports public clients, Client ID Metadata Document identifiers, and pre-registered confidential clients.
- Provider-advertised scopes are selected by default. A technically skilled user may override them; overrides are deduplicated and validated against OAuth scope-token syntax with a 500-character cap.
- PKCE always uses `S256`. Discovery fails if a provider advertises challenge methods without `S256`.
- Access tokens are refreshed sixty seconds before their reported expiry to avoid using a token that expires during a chat turn.
- If a provider omits `expires_in`, the token is treated as usable until the MCP server rejects it. A `401` or `403` during test moves the connection to `needs_reconnect`.
- Stored token documents contain only fields needed to use or refresh the connection, even though the entire document is encrypted.
- Encryption uses a unique 96-bit IV per record and purpose-bound additional authenticated data. PKCE state and server credentials cannot be swapped between rows without authentication failure.
- The protocol test uses MCP version `2025-11-25`, sends no user prompts or tool calls, and requires a valid JSON-RPC initialize result.
- The UI stays within the project’s square, high-contrast card/dialog system. Motion is limited to card lift, progress/discovery reveal, status pulse, icon rotation, and spinners, with reduced-motion fallbacks.
- Disconnect requires confirmation because it destroys stored credentials. The server record remains so reconnect is one click away.
- Remote OAuth token revocation is not attempted because the discovered metadata currently persisted by the feature does not include a guaranteed revocation endpoint. Local credentials are always removed immediately.
- No database migration was applied and no deployment was run, per the task constraints.

## Not fully verified

- A complete browser OAuth round trip against a real third-party MCP provider could not be verified because this workspace has no registered provider client, client secret, or test MCP account.
- DNS validation materially reduces SSRF risk but cannot eliminate time-of-check/time-of-use DNS rebinding by itself. Production should retain Cloudflare egress controls or an outbound proxy/allowlist where the deployment threat model requires a network-level guarantee.
- OAuth incremental authorization/step-up scopes and Dynamic Client Registration were not implemented. They are optional extensions beyond the initial connection flow.
- Provider-side token revocation on disconnect was not verified or implemented; a previously issued token may remain valid at the provider until it expires or is revoked there.
- The starter does not contain a chat route or chat execution runtime. The server-only accessor needed to supply authorized MCP connections to one is implemented and tested by its domain primitives, but no nonexistent chat UI could be wired end-to-end.
- Remote D1 concurrency behavior was not load-tested against a deployed database. The limit claim uses one conditional SQLite statement so the count and write are serialized by D1 rather than split across application requests.
- Encryption-key rotation is not automated. Rotation requires a separate controlled re-encryption procedure or user reconnection.
- The migrations were inspected and generated successfully but intentionally not applied. A local browser attempt reached the protected sign-in flow, but account creation correctly failed with `no such table: user` in the empty local D1 database. The dashboard interaction flow and screenshot therefore require a disposable migrated database prepared by a developer.

## Validation checklist

- `vp install`
- `vp run db:generate` (generation only; no apply)
- `vp check`
- `vp test`
- `vp build`
- Protected route and interaction checks with `agent-browser` when a disposable migrated local database is available

## References

- [MCP authorization specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
