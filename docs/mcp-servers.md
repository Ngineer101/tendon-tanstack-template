# MCP Server Connections

Users can connect [Model Context Protocol](https://modelcontextprotocol.io) servers from the
dashboard (`/dashboard`), authorize them via OAuth, and manage them over their lifetime
(connect → test → reconnect / edit → disconnect). Free plans are limited to 3 servers; the Pro
plan (`pro_monthly`) unlocks unlimited servers via the new `unlimited_mcp_servers` entitlement.

This document lists the micro-decisions and assumptions made during implementation, and the
things that could not be fully verified.

## Architecture overview

| Layer           | Files                                                                                |
| --------------- | ------------------------------------------------------------------------------------ |
| DB schema       | `src/db/schema.ts` (`mcp_server`, `mcp_oauth_state`), migration `drizzle/0002_*.sql` |
| Domain logic    | `src/lib/mcp/core.server.ts` (CRUD, limits, OAuth state machine)                     |
| Crypto          | `src/lib/mcp/crypto.server.ts` (AES-256-GCM, key from `MCP_ENCRYPTION_KEY`)          |
| SSRF guard      | `src/lib/mcp/url.server.ts`                                                          |
| OAuth discovery | `src/lib/mcp/discovery.server.ts` (RFC 8414 / RFC 9728 / MCP-spec fallback)          |
| OAuth helpers   | `src/lib/mcp/oauth.server.ts` (PKCE, RFC 7591 registration, token exchange)          |
| API routes      | `src/routes/api/mcp/**`                                                              |
| UI              | `src/components/mcp/**`, section rendered in `src/routes/_protected/dashboard.tsx`   |
| Tests           | `src/lib/mcp/*.test.ts` + `src/lib/mcp/testing/mock-d1.ts`                           |

### API surface

- `GET /api/mcp/servers` — list servers (client-safe DTOs) + plan usage.
- `POST /api/mcp/servers` — create row, enforce limit, run discovery, return
  `{ server, authorizationUrl | null }`.
- `PATCH /api/mcp/servers/:id` — rename / change URL (URL change clears credentials).
- `DELETE /api/mcp/servers/:id` — disconnect (deletes row; oauth state rows cascade).
- `POST /api/mcp/servers/:id/test` — connectivity + credential check.
- `POST /api/mcp/servers/:id/reconnect` — re-run discovery, return fresh `authorizationUrl`.
- `GET /api/mcp/oauth/callback` — OAuth redirect target; completes or abandons the attempt,
  then 303-redirects to `/dashboard?mcp=connected|denied|error`.

All mutations require `sameOrigin: true` and an authenticated session (same pattern as the
billing routes).

## Decisions & assumptions

### Security

1. **Encryption at rest.** OAuth token sets, PKCE verifiers, and dynamic client secrets are
   encrypted with AES-256-GCM (WebCrypto) before hitting D1. Payload format is
   `v1.<base64url(iv)>.<base64url(ct+tag)>`, so future key rotation can introduce a `v2`
   without a migration. The key is derived with SHA-256 from the `MCP_ENCRYPTION_KEY` env
   secret — any high-entropy string works; the raw secret never touches the DB or source.
2. **Key import is memoized per secret value.** `CryptoKey` objects are immutable handles, not
   user data, so caching them across requests in module scope is safe and avoids repeated
   SHA-256 derivation.
3. **Secrets never leave the server.** `toServerDto()` is the only serialization path to the
   client and contains no token/client-secret/encrypted fields. There is a dedicated test that
   serializes DTOs and asserts no secret material appears.
4. **SSRF protection** (`url.server.ts`): https-only, no credentials-in-URL, no loopback /
   private / link-local / reserved IP literals (v4+v6), no `localhost` / `*.local` /
   `*.internal` / `*.corp` / `*.lan` / `*.home`, hostnames must contain a dot (blocks
   single-label intranet names). The same guard is applied to URLs discovered from OAuth
   metadata _before_ redirecting the user or fetching them server-side.
5. **Open-redirect protection:** the OAuth callback only ever redirects to fixed app-relative
   paths (`/dashboard?mcp=...`, `/sign-in?redirect=/dashboard`). Nothing user-controlled is
   reflected into the `Location` header.
6. **Log/credential hygiene:** error messages that reach the UI, DB (`last_error`), or logs are
   limited to safe, static strings plus HTTP status codes and standard OAuth error codes
   (`invalid_grant`, …). Response bodies from third parties are never included. Fetch failures
   are re-thrown as sanitized `ApiError(502)`s. Tests assert raw error text (e.g. from network
   stacks) does not leak.
7. **OAuth hardening:** PKCE (S256) on every attempt; single-use, 10-minute-expiring state rows
   consumed before the token exchange (replay-safe); state is bound to the owning user; RFC
   8707 `resource` indicator sent at both authorize and token steps; session re-validated on
   the callback (state-less requests are bounced to sign-in).
8. **Ownership checks return 404**, not 403, for foreign rows so server existence is never
   leaked across accounts.
9. **Duplicate prevention:** unique index on `(user_id, url)` + a pre-check that returns 409
   with a friendly message; race-condition duplicates surface as 409 via constraint mapping.
10. **HTTP hardening details:** 8s timeouts on all outbound calls; response bodies of probes are
    cancelled promptly; JSON bodies are size-agnostic but strictly object-shaped before use.

### Billing / limits

11. **Limit enforcement is server-side and atomic.** Free users insert through
    `INSERT … SELECT … WHERE (SELECT COUNT(*) …) < 3`, mirroring the conditional-write style of
    the billing core (`consumeCredits`), so concurrent requests cannot race past the cap. Pro
    users (entitlement `unlimited_mcp_servers`, resolved through the existing
    `hasEntitlement`/`getBillingSummary` path) skip the guard entirely.
12. **The entitlement was added to the existing catalog**
    (`BILLING_CATALOG.subscriptionPlans.pro_monthly.entitlements`) rather than inventing a
    parallel plan check. Free-tier limit (3) lives in `src/lib/mcp/config.ts` and is shared
    between server and UI.
13. **Usage display:** the dashboard shows `n of 3 servers used` (free) or
    `n connected · unlimited plan` (pro). At the limit, the connect CTA is disabled and the
    dashed "add" tile becomes an upgrade tile linking to `/billing`.

### Flow & UX

14. **Failed discovery keeps the row.** If a newly added server can't be reached, the entry is
    kept with `status: "error"` + a sanitized `lastError` instead of failing the whole request
    — the user gets an actionable card (retry via reconnect, edit, or disconnect) rather than
    lost form input. A failed attempt therefore occupies a slot until removed (documented
    trade-off; keeps "my servers" honest).
15. **Status model:** `pending_auth` (awaiting OAuth), `connected`, `reconnect_required`
    (401/403, expired token, denied consent), `error` (network/5xx/discovery failures).
    `authType` is tracked separately: `unknown | none | oauth`.
16. **URL edits invalidate credentials.** Renames are instant; changing the URL clears
    `encrypted_auth`, the stored OAuth client registration, and any pending state rows, then
    drops the server back to `pending_auth` and immediately offers the reconnect dialog.
17. **Reconnect is the universal recovery action.** The same code path re-runs discovery and
    issues a fresh authorization URL; it powers the connect dialog's retry, the card's
    "Finish connecting"/"Reconnect" buttons, and the post-edit flow.
18. **Popup + polling UX.** Authorization opens in a 640×760 popup (blocked-popup fallback:
    explicit "Open authorization page" button). While the dialog waits, the server list is
    polled every 2.5s (TanStack Query `refetchInterval`) and the dialog advances automatically
    to a success state. "Finish later" leaves the server in `pending_auth`, resumable from the
    card. The popup is intentionally opened **without** `noopener`: the spec makes
    `window.open` return `null` when `noopener` is present, which would break both the
    blocked-popup detection and the auto-close-on-success. The opened page is the user's own
    MCP identity provider, and modern browsers heavily restrict cross-origin `window.opener`
    access.
19. **Test action semantics:** any non-auth HTTP response (including MCP-protocol 4xx) counts
    as "reachable" because it proves TLS + HTTP + routing; only 401/403 downgrade to
    `reconnect_required` and 5xx/network failures to `error`. Successful tests clear
    `lastError` and stamp `lastTestedAt`.
20. **Micro-animations** use the project's `tw-animate-css` primitives, all gated behind
    `motion-safe:` so reduced-motion preferences are respected: staggered card entrances
    (45ms steps, backwards fill), hover lifts on cards/tiles, pulsing status dots for
    action-needed states, a ping ring while waiting for OAuth, zoom-in success check,
    fade/slide banner entrances, and spinner swaps on every pending button.
21. **Visual language** follows existing patterns: `Card`/`Badge`/`Dialog` primitives, the
    billing page's `border-primary/30 bg-primary/10` (success) and
    `border-destructive/30 bg-destructive/10` (error) banner idioms, mono uppercase eyebrows
    (`font-mono text-xs uppercase tracking-[0.2em] text-primary`). Amber (`amber-500/…`) was
    introduced for "action needed" states since the palette had no warning tone.
22. **Two dialog instances** (connect + reconnect) share one component via a `reconnectTarget`
    prop instead of duplicating the OAuth waiting/success UX.

### OAuth / MCP spec

23. **Discovery order:** unauthenticated `initialize` probe → if 401/403, RFC 9728
    `WWW-Authenticate: resource_metadata` → RFC 8414 `oauth-authorization-server` on the server
    origin → MCP-spec default endpoints (`/authorize`, `/token`, `/register`). Probes send
    `MCP-Protocol-Version: 2025-06-18` and accept `application/json, text/event-stream` per the
    Streamable HTTP transport.
24. **Dynamic client registration (RFC 7591) is required.** Servers whose authorization server
    has no `registration_endpoint` fail with a clear 502 ("does not support dynamic client
    registration"). Supporting pre-registered/manual client IDs is future work.
25. **A fresh client registration is created per authorization attempt** instead of reusing the
    stored one. This avoids dead-ends when an issuer forgets a client, at the cost of
    accumulating registrations at the issuer (usually harmless and auto-expiring).
26. **No automatic token refresh.** Expired access tokens (per stored `expiresAt`) flip the
    server to `reconnect_required` and the user reconnects interactively. A `refresh_token`
    grant path is deliberately out of scope for this iteration.
27. **No token revocation on disconnect.** Rows (and their encrypted credentials) are deleted;
    issuers that support RFC 7009 revocation could be integrated later.
28. **Chat integration seam:** `getConnectedServersWithAuth(env, userId)` in
    `core.server.ts` returns connected servers with _decrypted_ token sets for server-side chat
    code. This template ships no chat UI, so the seam is exported and tested but not consumed
    yet.

### Testing

29. **Tests run against the real migration SQL.** The `MockD1` shim (better-sqlite3) applies
    every file in `drizzle/` in order, so schema drift between migrations and tests is
    impossible. The shim implements exactly the `prepare/bind/run/all/raw/batch` surface that
    `drizzle-orm/d1` uses.
30. **Coverage focus** (per requirements): crypto round-trip/tamper/wrong-key, SSRF matrix,
    discovery fallbacks + metadata-SSRF, OAuth error sanitization, domain-level authorization
    (404 across users), the 3-server limit (happy path, pre-seeded race path, pro-unlimited),
    duplicate-URL 409, OAuth completion + single-use state, and test/reconnect status
    transitions.
31. **HTTP-level route tests were intentionally not added.** The route wrappers import
    `cloudflare:workers`, which isn't available under plain Vitest; API behavior is covered at
    the domain layer (same `ApiError` contract the routes translate to JSON). This is listed
    under "not fully verified" below.

## Verified live during development

Exercised against the local dev server (workerd) with real third-party servers:

- **DeepWiki (`mcp.deepwiki.com`)** — unauthenticated `initialize` probe, immediate
  `connected` state, and the `test` action (`ok: true`).
- **Linear (`mcp.linear.app`)** — full discovery (401 → RFC 8414 metadata), dynamic client
  registration, PKCE authorization URL, popup to Linear's real consent screen, and the
  **denial path**: Linear's "Cancel" redirected to `/api/mcp/oauth/callback?error=access_denied`,
  the state row was consumed, the server flipped to `reconnect_required` with
  "Authorization was denied or cancelled", and the dashboard showed the `?mcp=denied` banner.
- **GitHub (`api.githubcopilot.com/mcp`)** — discovery succeeded but GitHub's authorization
  server rejected dynamic client registration; the dialog surfaced the sanitized 502 and the
  entry was kept in `error` state for retry/edit/removal.
- **API guards via curl:** SSRF rejections (localhost, `169.254.169.254`), missing-origin 403,
  unauthenticated 401, duplicate-URL 409, foreign-id 404, the 3-server limit (403 with
  `code: limit_reached`), URL-edit credential reset, reconnect, and delete.

## Not fully verified / known limitations

- **Completing a real OAuth grant end-to-end** (Approve → code exchange → encrypted tokens)
  was not possible without real third-party accounts (Linear/GitHub). Everything up to the
  consent screen and the denial callback was verified live; the exchange itself is covered by
  mocked-fetch tests, including single-use state replay and error mapping.
- **DNS-rebinding SSRF:** hostnames are not resolved before fetching (Workers egress runs from
  Cloudflare's network, so a customer's private network is unreachable regardless), but a
  public hostname that resolves to a private address is not detectable here.
- **SSE (text/event-stream) responses** from probes are detected by status only; the stream is
  cancelled without parsing events.
- **MCP protocol versions** other than `2025-06-18` aren't negotiated; servers that reject the
  header still answer the probe, which is all discovery needs.
- **Full HTTP route tests** (cookie session → API JSON) require a miniflare-backed test setup
  that this template doesn't have yet; see decision 31.
- **Screenshots** in `docs/screenshots/` were captured in dark mode against local dev. The
  OAuth consent screen shots show Linear's real authorization page; the grant itself was not
  completed (see above).

## Setup

1. Generate a key: `openssl rand -base64 32`
2. Local dev: add `MCP_ENCRYPTION_KEY=<key>` to `.dev.vars` (gitignored).
3. Production: `pnpm exec wrangler secret put MCP_ENCRYPTION_KEY`
4. Apply the migration (not run automatically): `pnpm run db:migrate` locally,
   `pnpm run db:migrate:prod` in production.
