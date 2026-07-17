# MCP Server Connections

## What was implemented

- The protected `/dashboard` page lists configured MCP servers in a responsive grid and exposes
  connect, discover, authenticate, reconnect, edit, protocol-test, and confirmed disconnect flows.
- Authenticated same-origin API routes own every mutation. The browser receives connection
  metadata and OAuth endpoints, but never tokens, client secrets, PKCE verifiers, or ciphertext.
- `mcp_server_connection` stores durable connection metadata and encrypted authorization data.
  `mcp_oauth_state` stores one-time, ten-minute OAuth handshakes.
- OAuth follows authorization-code PKCE, Protected Resource Metadata discovery, OAuth or OIDC
  authorization-server metadata discovery, the RFC 8707 `resource` parameter, and optional Dynamic
  Client Registration.
- Stored access tokens are refreshed server-side when possible. A failed or unavailable refresh
  changes the connection to `needs_reconnect`.
- `getMcpConnectionsForChat()` is the server-only adapter for chat handlers. It returns only usable,
  user-owned connections with fresh bearer authorization and must never be serialized or logged.
- The **Test** action sends an authenticated MCP `initialize` request using protocol version
  `2025-11-25`; response bodies are cancelled rather than buffered.

## Billing and limits

- Pro receives the `unlimited_mcp_servers` entitlement in the existing billing catalog.
- A free account may have at most three records whose status is not `disconnected`.
- The limit is checked before OAuth starts for fast feedback and checked again when OAuth completes.
- Completion uses one conditional SQLite statement for the count and write. This closes the race in
  which several callbacks could otherwise observe two connections and all create a third/fourth.
- Reauthorizing an already-active record does not consume another slot. Reactivating a disconnected
  record does consume a slot and is blocked when all three are occupied.

## Security decisions

- `MCP_AUTH_ENCRYPTION_KEY` is a server environment secret with a minimum of 32 characters. AES-GCM
  uses a fresh 96-bit IV per envelope; the key is never stored in source or D1.
- Access tokens, refresh tokens, token endpoints, audience, and any client secret needed for refresh
  live inside the encrypted durable envelope.
- OAuth `state` is stored as a SHA-256 hash. The PKCE verifier and dynamic-registration secret are
  encrypted even though their handshake row is short-lived.
- A callback atomically deletes and returns its state row before exchanging the code. A state is
  therefore single-use, user-bound, and expiry-bound.
- OAuth callback failures expose only curated `ApiError` messages. Unexpected API logs contain an
  error ID and error type, not exception messages, request bodies, URLs, headers, or credentials.
- Outbound URLs must be HTTPS, contain no URL credentials, use a public FQDN, and avoid localhost,
  internal suffixes, private/special IPv4 ranges, IP-literal IPv6, and known metadata hostnames.
- Discovery, registration, token, refresh, and test requests use a ten-second timeout, reject every
  redirect, and bound JSON bodies to 64 KB.
- Protected Resource Metadata may advertise an audience only on the configured MCP origin. OAuth
  metadata issuer values are matched against the advertised authorization server to reduce mix-up
  attacks.
- Authorization and token requests both carry the MCP resource audience. Tokens are sent only in
  the `Authorization: Bearer` header and never in a URL.
- Mutation APIs require an exact `Origin` match. OAuth redirect URIs are built from
  `BETTER_AUTH_URL`, and the request origin must match that configured origin.
- Disconnect is a soft delete for audit-friendly UI state, but encrypted credentials are removed
  immediately.

## Environment setup

Configure local values in `.env.local`. Configure production values with environment secrets, for
example:

```sh
vp exec wrangler secret put MCP_AUTH_ENCRYPTION_KEY
```

`MCP_OAUTH_CLIENT_ID` and `MCP_OAUTH_CLIENT_SECRET` are optional fallbacks for authorization servers
without Dynamic Client Registration. They must also be server secrets. A single fallback client ID
is only suitable when it is registered for the target authorization server and callback URL.

## Migration notes

- `drizzle/0002_remarkable_calypso.sql` creates both MCP tables.
- `drizzle/0003_special_mathemanic.sql` adds the resource audience to OAuth state.
- Migration `0003` clears only short-lived, in-progress OAuth state rows before adding the required
  audience. Users with an in-flight authorization will need to restart it; configured connections
  are preserved.
- The migrations were generated but **not applied**, per the implementation constraint.

## Micro-decisions and assumptions

- “Connected” for the free limit means `connected`, `needs_reconnect`, or `error`; only an explicit
  disconnect releases a slot.
- Disconnected cards remain in the grid to make reconnect and prior configuration discoverable.
- Editing a display name preserves credentials. Editing the URL clears credentials and requires a
  new OAuth grant because tokens must not be forwarded to a different resource.
- OAuth discovery is an explicit UI step. Authentication stays disabled until the user can review
  issuer, authorization endpoint, token endpoint, audience, and registration availability.
- If the user leaves scopes blank, the flow uses the scopes advertised by Protected Resource
  Metadata. Explicit scopes are intersected with advertised scopes; an entirely unsupported request
  is rejected instead of silently broadening permissions.
- The newest stable MCP protocol version available during implementation (`2025-11-25`) is used for
  the connection test; the July 2026 stateless protocol was still a release candidate.
- A protocol test initializes a new MCP session but does not list or invoke tools. This validates
  network reachability, bearer authorization, and MCP protocol compatibility without performing a
  user workflow.
- Failed refreshes make only that connection unavailable to chat; other valid connections are still
  returned.
- Server URL fragments are discarded. Paths and query strings are retained because they can identify
  a concrete MCP HTTP endpoint.
- IPv6 literal URLs are rejected conservatively. Public hostnames resolving over IPv6 remain allowed.
- Existing card, badge, button, input, dialog, typography, color, spacing, and animation primitives
  were reused. Motion is brief and uses `motion-safe` where continuous animation is involved.

## Tests added

- URL normalization and SSRF rejection, including alternative IPv4 and IPv6 literals.
- Free/paid limit rules and atomic SQLite persistence at the three-server boundary.
- Ownership checks that do not reveal another user’s connection.
- Exact same-origin and authenticated-session API guards.
- JSON content-type, malformed body, validation, secret-safe error, and body-size errors.
- AES-GCM round-trip, missing key, plaintext absence, and tamper rejection.
- Redirect refusal, challenge discovery, path-specific Protected Resource Metadata, issuer discovery,
  audience binding, and cross-origin audience rejection.

## Not fully verified

- No live third-party MCP provider and OAuth account were available, so provider-specific discovery,
  consent, dynamic registration, refresh, and initialize interoperability remain unverified.
- Application-level URL checks cannot fully defeat DNS rebinding or a public hostname that later
  resolves privately. Production should also enforce egress/DNS policy outside this application.
- There is no chat route in this starter to wire into. The encrypted storage, refresh logic, and
  server-only `getMcpConnectionsForChat()` adapter are complete, but a future chat implementation
  must pass those connections into its MCP client without serializing credentials.
- Browser verification reached the protected sign-in boundary, but the local D1 instance had no
  auth tables. Because migrations were explicitly out of scope, no local account was created and no
  dashboard screenshot was saved. This is not a live OAuth interoperability proof.
