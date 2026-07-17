# MCP Server Management — Implementation Decisions

## Micro-decisions and Assumptions

### 1. OAuth Flow via Popup Window

**Decision:** Used a popup window for the OAuth authorization flow instead of a full-page redirect.
**Rationale:** Keeps the user on the dashboard context, avoiding a multi-page redirect flow that could be disorienting. The popup closes automatically on completion.
**Trade-off:** Requires popup permission; falls back gracefully with an error message if blocked.

### 2. PKCE for OAuth

**Decision:** Always use PKCE (SHA-256) with the authorization code flow, even though we store the verifier server-side.
**Rationale:** PKCE is a security best practice for OAuth. Even though we're not a public/mobile client, it adds defense-in-depth against authorization code interception.

### 3. Encryption Algorithm

**Decision:** AES-256-GCM via the Web Crypto API (available in Cloudflare Workers runtime).
**Rationale:** Authenticated encryption with a 256-bit key. GCM provides both confidentiality and integrity. The key is derived from the `MCP_ENCRYPTION_KEY` environment secret.

### 4. Encryption Key Format

**Decision:** 32-byte base64-encoded string in environment variables.
**Rationale:** Workers has no filesystem for key files. Base64 is transport-safe and easy to generate (`openssl rand -base64 32`).

### 5. SSRF Protection Strategy

**Decision:** Multi-layered hostname validation:

- Reject non-HTTPS schemes
- Reject private/internal IP ranges (10.x, 172.16-31.x, 192.168.x, 169.254.x, 127.x)
- Reject localhost, .local, .internal, .corp TLDs
- Reject single-label hostnames
- Reject raw IP addresses
- Use `redirect: "manual"` on all outbound fetch calls
- Validate redirect targets before following
  **Rationale:** Workers cannot do DNS resolution at request time, so hostname-based filtering is the primary defense. `redirect: manual` prevents transparent redirects to internal networks.

### 6. URL Validation After OAuth Discovery

**Decision:** Validate all discovered OAuth endpoints (authorization, token) through the same SSRF checks.
**Rationale:** An attacker could configure an MCP server's discovery document to point to internal endpoints.

### 7. Free Tier Server Limit

**Decision:** Enforced server-side via `$count` query before creating a new server. Integrated with the existing billing/entitlement system via `getBillingSummary`.
**Rationale:** Server-side enforcement is mandatory for security; the client-side UI is purely cosmetic. Paying users (pro_monthly plan) skip the limit check.

### 8. OAuth State Storage

**Decision:** Temporary table (`mcp_oauth_state`) with a 10-minute expiry. State includes PKCE verifier, OAuth state parameter, and redirect URI.
**Rationale:** The PKCE verifier must be stored between authorization request and token exchange. The expiry prevents stale state accumulation.

### 9. Token Storage

**Decision:** The entire token response (access_token, refresh_token, expires_in, etc.) is JSON-stringified and encrypted before DB storage.
**Rationale:** Storing the full response allows future use of refresh tokens. Encryption ensures plaintext tokens are never in the DB.

### 10. Client-Side Token Exposure

**Decision:** Tokens are never sent to the client. API responses include only non-sensitive metadata (id, label, URL, status).
**Rationale:** Prevents token leakage through client-side inspection or XSS.

### 11. Test Connection Flow

**Decision:** Backend decrypts the stored token and makes an authenticated GET request to the server URL.
**Rationale:** Tests are server-initiated to keep tokens off the client. Results update the server's status field.

### 12. Disconnect Safety

**Decision:** Client-side `window.confirm()` dialog before DELETE request. Server-side soft-deletes via D1 cascade (no retention).
**Rationale:** Double confirmation prevents accidental disconnection. No undo — the user can reconnect anytime.

### 13. UI Component Architecture

**Decision:** Four components: `McpConnectDialog` (connect flow), `McpEditDialog` (edit flow), `McpServerCard` (per-server card), `McpServerGrid` (container with empty/loading/error states).
**Rationale:** Separation of concerns. Each component handles its own API calls and local state. The grid handles collection-level states.

### 14. Micro-animations

**Decision:** CSS transitions on card hover (`group-hover:border-primary/30`, `group-hover:shadow-sm`), icon transitions (`group-hover:text-primary`), skeleton loading states with `animate-pulse`, spinner animations on async actions.
**Rationale:** Subtle animations that follow existing project patterns (tailwindcss-animate, tw-animate-css).

### 15. Design Pattern Consistency

**Decision:** Followed existing patterns from the billing page:

- Same container width (`max-w-6xl`)
- Same section header style (mono font, uppercase, tracking-wide)
- Same card grid (`grid gap-4 sm:grid-cols-2 lg:grid-cols-3`)
- Same error display (border with destructive colors)
- Same button variants (outline, ghost, default)
- Same typography scale

### 16. Database Migration

**Decision:** Created migration `0002_zippy_nightcrawler.sql` with two tables: `mcp_server` and `mcp_oauth_state`.
**Rationale:** Follows existing migration numbering (0000, 0001). Both tables cascade on user/server deletion.

### 17. HTTP Only for OAuth Callback

**Decision:** The OAuth callback (`/api/mcp/callback`) is a public route (not authenticated) that renders HTML pages for success/error.
**Rationale:** MCP servers redirect the user's browser to our callback. We can't require auth on this endpoint because it's a browser redirect. Security is maintained through OAuth state verification and PKCE.

### 18. Client ID Strategy

**Decision:** Hardcoded client ID `"mcp-client"` for OAuth flows.
**Rationale:** For an open-standard MCP ecosystem, dynamic client registration is not universally supported. Using a consistent client ID simplifies integration. This could be made configurable per-server in the future.

## Things That Could Not Be Fully Verified

### 1. Actual MCP Server OAuth Discovery

The OAuth discovery flow fetches `/.well-known/oauth-authorization-server` per the MCP spec (draft), but without a real MCP server implementation, the discovery response format and token exchange behavior could not be tested end-to-end. The implementation is based on the MCP specification draft.

### 2. Stripe Integration with BillingEnv Extension

`MCPEnv` extends `BillingEnv` (which extends `Cloudflare.Env`), meaning all Stripe-related env vars are required in the MCP context. This was validated at the type level but not runtime-tested with an actual Stripe environment.

### 3. Popup Window Behavior

The popup-based OAuth flow was designed but cannot be verified without a real OAuth server. Cross-origin `window.postMessage` for the "mcp-oauth-complete" event relies on the callback page sending the message. In the current implementation, the OAuth callback page renders HTML success/error pages but does NOT call `window.opener.postMessage`. The fallback is the interval-based popup-close detection. **This should be addressed before production use**: the callback HTML page should include a script that posts a message to `window.opener`.

### 4. Refresh Token Flow

The implementation stores the full token response (including refresh_token), but refresh token rotation is not implemented. Tokens that expire will show as "error" status and the user must manually reconnect.

### 5. D1 Migration Application

The migration SQL file was created but not applied. The `wrangler d1 migrations apply` command was not run as per instructions.

### 6. Screenshot of the Feature

Attempted but requires a running dev server with database setup. Could not be completed in the current environment without running migrations.
