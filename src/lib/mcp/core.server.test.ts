import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DB } from "#/db";
import { mcpOauthTransaction, mcpServer } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import {
  completeOAuthCallback,
  deleteServer,
  getServerQuota,
  listServers,
  McpServerLimitError,
  reconnectServer,
  startConnection,
  testServer,
  updateServer,
  type McpCoreEnv,
} from "./core.server";
import { decryptJson, encryptJson } from "./crypto.server";
import { createTestDatabase, seedProSubscription, seedUser } from "./testing/test-db";

const TEST_KEY = Buffer.from("k".repeat(32)).toString("base64");
const ORIGIN = "https://app.example.com";

let d1: D1Database;
let db: DB;
let env: McpCoreEnv;

beforeEach(async () => {
  ({ d1, db } = createTestDatabase());
  env = {
    DB: d1,
    MCP_ENCRYPTION_KEY: TEST_KEY,
    STRIPE_SECRET_KEY: "sk_test",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    STRIPE_PRO_MONTHLY_PRICE_ID: "price_pro",
    STRIPE_CREDITS_1000_PRICE_ID: "price_1000",
    STRIPE_CREDITS_5000_PRICE_ID: "price_5000",
    STRIPE_CREDITS_20000_PRICE_ID: "price_20000",
  } as unknown as McpCoreEnv;
  await seedUser(db, "user_free");
  await seedUser(db, "user_pro");
  await seedUser(db, "user_other");
  await seedProSubscription(db, "user_pro");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

type FetchHandler = (url: URL, init: RequestInit) => Response | undefined;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function bodyJson(init: RequestInit): { method?: string; id?: string | number } {
  return JSON.parse(init.body as string) as { method?: string; id?: string | number };
}

function bodyParams(init: RequestInit) {
  return new URLSearchParams(init.body as string);
}

function stubFetch(handler: FetchHandler) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const response = handler(url, init ?? {});
      if (response) return response;
      throw new Error(`Unhandled fetch in test: ${init?.method ?? "GET"} ${url}`);
    }),
  );
}

/** Allow-list DNS answers for every hostname. */
function handleDns(url: URL, addresses = ["93.184.216.34"]) {
  if (url.hostname === "cloudflare-dns.com") {
    return jsonResponse({ Answer: addresses.map((data) => ({ data })) });
  }
  return undefined;
}

function handleInitialize(
  _url: URL,
  init: RequestInit,
  serverInfo = { name: "Demo MCP", version: "1.2.3" },
) {
  if (init.method === "POST" && bodyJson(init).method === "initialize") {
    return jsonResponse({
      jsonrpc: "2.0",
      id: bodyJson(init).id,
      result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo },
    });
  }
  return undefined;
}

function stubPublicNoAuthServer() {
  stubFetch((url, init) => handleDns(url) ?? handleInitialize(url, init));
}

async function seedServerRow(
  userId: string,
  overrides: Partial<typeof mcpServer.$inferInsert> = {},
) {
  const id = overrides.id ?? `mcpsrv_${crypto.randomUUID()}`;
  await db.insert(mcpServer).values({
    id,
    userId,
    name: overrides.name ?? "Demo",
    url: overrides.url ?? `https://mcp-${id.slice(-6)}.example.com/mcp`,
    status: overrides.status ?? "connected",
    authType: overrides.authType ?? "none",
    encryptedAuth: overrides.encryptedAuth ?? null,
    serverName: overrides.serverName ?? null,
    serverVersion: overrides.serverVersion ?? null,
    lastError: overrides.lastError ?? null,
  });
  return id;
}

async function getRow(id: string) {
  return db.query.mcpServer.findFirst({ where: eq(mcpServer.id, id) });
}

// ---------------------------------------------------------------------------
// startConnection
// ---------------------------------------------------------------------------

describe("startConnection", () => {
  it("connects a no-auth server end to end", async () => {
    stubPublicNoAuthServer();
    const result = await startConnection(env, "user_free", ORIGIN, {
      name: "Demo",
      url: "https://mcp.example.com/mcp",
    });

    expect(result.type).toBe("connected");
    if (result.type !== "connected") return;
    expect(result.server.status).toBe("connected");
    expect(result.server.authType).toBe("none");
    expect(result.server.serverName).toBe("Demo MCP");
    expect(result.server.url).toBe("https://mcp.example.com/mcp");

    const row = await getRow(result.server.id);
    expect(row?.userId).toBe("user_free");
    expect(row?.encryptedAuth).toBeNull();
  });

  it("rejects private-network URLs before any network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      startConnection(env, "user_free", ORIGIN, { name: "x", url: "https://169.254.169.254/" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid input", async () => {
    await expect(
      startConnection(env, "user_free", ORIGIN, { name: "", url: "https://mcp.example.com" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      startConnection(env, "user_free", ORIGIN, { name: "x", url: "javascript:alert(1)" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("returns 409 when the same URL is connected twice", async () => {
    stubPublicNoAuthServer();
    const input = { name: "Demo", url: "https://mcp.example.com/mcp" };
    await startConnection(env, "user_free", ORIGIN, input);
    await expect(startConnection(env, "user_free", ORIGIN, input)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("normalizes URLs before duplicate comparison", async () => {
    stubPublicNoAuthServer();
    await startConnection(env, "user_free", ORIGIN, {
      name: "Demo",
      url: "https://mcp.example.com/mcp/",
    });
    await expect(
      startConnection(env, "user_free", ORIGIN, {
        name: "Demo",
        url: "https://mcp.example.com/mcp",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("surfaces unreachable servers as a 400", async () => {
    stubFetch(
      (url, init) =>
        handleDns(url) ??
        (init.method === "POST" ? new Response(null, { status: 502 }) : undefined),
    );
    await expect(
      startConnection(env, "user_free", ORIGIN, { name: "x", url: "https://mcp.example.com/mcp" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------
// Plan limits
// ---------------------------------------------------------------------------

describe("three-server limit", () => {
  beforeEach(() => {
    stubPublicNoAuthServer();
  });

  it("allows a free user to connect up to 3 servers", async () => {
    for (let i = 0; i < 3; i += 1) {
      const result = await startConnection(env, "user_free", ORIGIN, {
        name: `Server ${i}`,
        url: `https://mcp-${i}.example.com/mcp`,
      });
      expect(result.type).toBe("connected");
    }
    const quota = await getServerQuota(env, "user_free");
    expect(quota).toMatchObject({ plan: "free", used: 3, limit: 3 });
  });

  it("blocks the 4th server for a free user with a 403", async () => {
    for (let i = 0; i < 3; i += 1) {
      await startConnection(env, "user_free", ORIGIN, {
        name: `Server ${i}`,
        url: `https://mcp-${i}.example.com/mcp`,
      });
    }
    const error = await startConnection(env, "user_free", ORIGIN, {
      name: "One too many",
      url: "https://mcp-3.example.com/mcp",
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(McpServerLimitError);
    expect((error as ApiError).status).toBe(403);

    const servers = await listServers(db, "user_free");
    expect(servers).toHaveLength(3);
  });

  it("lets a pro user exceed the free limit", async () => {
    for (let i = 0; i < 4; i += 1) {
      const result = await startConnection(env, "user_pro", ORIGIN, {
        name: `Server ${i}`,
        url: `https://mcp-${i}.example.com/mcp`,
      });
      expect(result.type).toBe("connected");
    }
    const quota = await getServerQuota(env, "user_pro");
    expect(quota).toMatchObject({ plan: "pro_monthly", used: 4, limit: null });
  });

  it("does not count other users' servers against the limit", async () => {
    for (let i = 0; i < 3; i += 1) {
      await startConnection(env, "user_other", ORIGIN, {
        name: `Other ${i}`,
        url: `https://other-${i}.example.com/mcp`,
      });
    }
    const result = await startConnection(env, "user_free", ORIGIN, {
      name: "Mine",
      url: "https://mine.example.com/mcp",
    });
    expect(result.type).toBe("connected");
  });
});

// ---------------------------------------------------------------------------
// OAuth flow
// ---------------------------------------------------------------------------

function stubOAuthDiscovery() {
  stubFetch((url, init) => {
    const dns = handleDns(url);
    if (dns) return dns;

    if (url.hostname === "mcp.example.com" && init.method === "POST") {
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="https://auth.example.com/.well-known/oauth-protected-resource"`,
        },
      });
    }
    if (url.href === "https://auth.example.com/.well-known/oauth-protected-resource") {
      return jsonResponse({
        resource: "https://mcp.example.com/mcp",
        authorization_servers: ["https://auth.example.com"],
      });
    }
    if (url.href === "https://auth.example.com/.well-known/oauth-authorization-server") {
      return jsonResponse({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: "https://auth.example.com/register",
      });
    }
    if (url.href === "https://auth.example.com/register" && init.method === "POST") {
      return jsonResponse({ client_id: "client-xyz-123" });
    }
    return undefined;
  });
}

describe("OAuth connect flow", () => {
  it("discovers OAuth and returns an authorization URL with PKCE", async () => {
    stubOAuthDiscovery();
    const result = await startConnection(env, "user_free", ORIGIN, {
      name: "OAuth demo",
      url: "https://mcp.example.com/mcp",
    });

    expect(result.type).toBe("authorization_required");
    if (result.type !== "authorization_required") return;

    const authorizationUrl = new URL(result.authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://auth.example.com");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("client-xyz-123");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/api/mcp/oauth/callback`,
    );

    const state = authorizationUrl.searchParams.get("state")!;
    const tx = await db.query.mcpOauthTransaction.findFirst({
      where: eq(mcpOauthTransaction.id, state),
    });
    expect(tx?.userId).toBe("user_free");
    // Registration details are encrypted at rest — the row must not leak them.
    expect(tx?.encryptedPayload).not.toContain("client-xyz-123");
    const payload = await decryptJson<{ client: { clientId: string } }>(env, tx!.encryptedPayload);
    expect(payload.client.clientId).toBe("client-xyz-123");
  });

  it("completes the callback, stores encrypted tokens, and consumes the transaction", async () => {
    stubOAuthDiscovery();
    const start = await startConnection(env, "user_free", ORIGIN, {
      name: "OAuth demo",
      url: "https://mcp.example.com/mcp",
    });
    if (start.type !== "authorization_required") throw new Error("expected oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;

    const seenAuthorizations: string[] = [];
    stubFetch((url, init) => {
      const dns = handleDns(url);
      if (dns) return dns;
      if (url.href === "https://auth.example.com/token" && init.method === "POST") {
        const body = bodyParams(init);
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("auth-code-1");
        expect(body.get("code_verifier")).toBeTruthy();
        return jsonResponse({
          access_token: "access-token-aaa",
          refresh_token: "refresh-token-bbb",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (url.hostname === "mcp.example.com" && init.method === "POST") {
        seenAuthorizations.push(String(new Headers(init.headers).get("authorization")));
        return handleInitialize(url, init);
      }
      return undefined;
    });

    const server = await completeOAuthCallback(env, "user_free", {
      code: "auth-code-1",
      state,
    });

    expect(server.status).toBe("connected");
    expect(server.authType).toBe("oauth");
    expect(server.serverName).toBe("Demo MCP");
    expect(seenAuthorizations).toContain("Bearer access-token-aaa");

    const row = await getRow(server.id);
    expect(row?.encryptedAuth).toBeTruthy();
    expect(row?.encryptedAuth).not.toContain("access-token-aaa");
    const stored = await decryptJson<{ tokens: { accessToken: string; refreshToken: string } }>(
      env,
      row!.encryptedAuth!,
    );
    expect(stored.tokens.accessToken).toBe("access-token-aaa");
    expect(stored.tokens.refreshToken).toBe("refresh-token-bbb");

    // Transaction is single-use.
    await expect(
      completeOAuthCallback(env, "user_free", { code: "auth-code-1", state }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects callbacks for another user", async () => {
    stubOAuthDiscovery();
    const start = await startConnection(env, "user_free", ORIGIN, {
      name: "OAuth demo",
      url: "https://mcp.example.com/mcp",
    });
    if (start.type !== "authorization_required") throw new Error("expected oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;

    await expect(
      completeOAuthCallback(env, "user_other", { code: "auth-code-1", state }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("enforces the plan limit again when the OAuth callback completes", async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedServerRow("user_free", { url: `https://seeded-${i}.example.com/mcp` });
    }

    stubOAuthDiscovery();
    const start = await startConnection(env, "user_free", ORIGIN, {
      name: "OAuth demo",
      url: "https://mcp.example.com/mcp",
    });
    if (start.type !== "authorization_required") throw new Error("expected oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;

    stubFetch((url, init) => {
      if (url.href === "https://auth.example.com/token") {
        return jsonResponse({ access_token: "tok", token_type: "Bearer" });
      }
      if (url.hostname === "mcp.example.com" && init.method === "POST") {
        return handleInitialize(url, init);
      }
      return undefined;
    });

    await expect(
      completeOAuthCallback(env, "user_free", { code: "auth-code-1", state }),
    ).rejects.toBeInstanceOf(McpServerLimitError);
  });

  it("rejects expired transactions", async () => {
    stubOAuthDiscovery();
    const start = await startConnection(env, "user_free", ORIGIN, {
      name: "OAuth demo",
      url: "https://mcp.example.com/mcp",
    });
    if (start.type !== "authorization_required") throw new Error("expected oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;

    await db
      .update(mcpOauthTransaction)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mcpOauthTransaction.id, state));

    await expect(
      completeOAuthCallback(env, "user_free", { code: "auth-code-1", state }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------
// updateServer
// ---------------------------------------------------------------------------

describe("updateServer", () => {
  it("renames without touching stored credentials", async () => {
    const encryptedAuth = await encryptJson(env, { tokens: { accessToken: "keep-me" } });
    const id = await seedServerRow("user_free", { authType: "oauth", encryptedAuth });

    const updated = await updateServer(env, "user_free", id, { name: "Renamed" });
    expect(updated.name).toBe("Renamed");
    const row = await getRow(id);
    expect(row?.encryptedAuth).toBe(encryptedAuth);
    expect(row?.status).toBe("connected");
  });

  it("clears credentials and requires re-auth when the URL changes", async () => {
    stubFetch((url) => handleDns(url));
    const encryptedAuth = await encryptJson(env, { tokens: { accessToken: "drop-me" } });
    const id = await seedServerRow("user_free", { authType: "oauth", encryptedAuth });

    const updated = await updateServer(env, "user_free", id, {
      url: "https://new-endpoint.example.com/mcp",
    });
    expect(updated.status).toBe("requires_auth");
    const row = await getRow(id);
    expect(row?.encryptedAuth).toBeNull();
    expect(row?.url).toBe("https://new-endpoint.example.com/mcp");
    expect(row?.lastError).toContain("reconnect");
  });

  it("rejects a URL already used by another server of the same user", async () => {
    stubFetch((url) => handleDns(url));
    const first = await seedServerRow("user_free", { url: "https://a.example.com/mcp" });
    await seedServerRow("user_free", { url: "https://b.example.com/mcp" });
    await expect(
      updateServer(env, "user_free", first, { url: "https://b.example.com/mcp" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects private URLs", async () => {
    const id = await seedServerRow("user_free");
    await expect(
      updateServer(env, "user_free", id, { url: "https://192.168.0.10/mcp" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("returns 404 for servers owned by someone else", async () => {
    const id = await seedServerRow("user_free");
    await expect(updateServer(env, "user_other", id, { name: "nope" })).rejects.toMatchObject({
      status: 404,
    });
  });
});

// ---------------------------------------------------------------------------
// testServer
// ---------------------------------------------------------------------------

describe("testServer", () => {
  it("reports tool counts for healthy no-auth servers", async () => {
    stubFetch((url, init) => {
      const dns = handleDns(url);
      if (dns) return dns;
      const body = bodyJson(init);
      if (body.method === "initialize") return handleInitialize(url, init);
      if (body.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "search" }, { name: "create_issue" }] },
        });
      }
      return undefined;
    });

    const id = await seedServerRow("user_free");
    const result = await testServer(env, "user_free", id);
    expect(result).toMatchObject({ ok: true, toolCount: 2, serverName: "Demo MCP" });

    const row = await getRow(id);
    expect(row?.status).toBe("connected");
    expect(row?.lastTestedAt).toBeTruthy();
  });

  it("supports SSE responses from streamable servers", async () => {
    stubFetch((url, init) => {
      const dns = handleDns(url);
      if (dns) return dns;
      const body = bodyJson(init);
      const payload =
        body.method === "initialize"
          ? {
              jsonrpc: "2.0",
              id: body.id,
              result: { serverInfo: { name: "SSE MCP", version: "2" } },
            }
          : { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "only_tool" }] } };
      return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const id = await seedServerRow("user_free");
    const result = await testServer(env, "user_free", id);
    expect(result).toMatchObject({ ok: true, toolCount: 1, serverName: "SSE MCP" });
  });

  it("refreshes expired OAuth tokens and persists the rotation", async () => {
    const encryptedAuth = await encryptJson(env, {
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "client-xyz-123",
      tokens: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 60_000,
        tokenType: "Bearer",
      },
    });
    const id = await seedServerRow("user_free", { authType: "oauth", encryptedAuth });

    const seen: string[] = [];
    stubFetch((url, init) => {
      const dns = handleDns(url);
      if (dns) return dns;
      if (url.href === "https://auth.example.com/token") {
        const body = bodyParams(init);
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("old-refresh");
        return jsonResponse({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (init.method === "POST") {
        const body = bodyJson(init);
        seen.push(`${body.method}:${String(new Headers(init.headers).get("authorization"))}`);
        if (body.method === "initialize") return handleInitialize(url, init);
        if (body.method === "tools/list") {
          return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
        }
      }
      return undefined;
    });

    const result = await testServer(env, "user_free", id);
    expect(result.ok).toBe(true);
    expect(seen).toContain("initialize:Bearer new-access");

    const row = await getRow(id);
    const stored = await decryptJson<{
      tokens: { accessToken: string; refreshToken: string };
    }>(env, row!.encryptedAuth!);
    expect(stored.tokens.accessToken).toBe("new-access");
    expect(stored.tokens.refreshToken).toBe("new-refresh");
  });

  it("marks the server requires_auth when the stored token is rejected", async () => {
    const encryptedAuth = await encryptJson(env, {
      tokenEndpoint: "https://auth.example.com/token",
      clientId: "client-xyz-123",
      tokens: { accessToken: "revoked", tokenType: "Bearer" },
    });
    const id = await seedServerRow("user_free", { authType: "oauth", encryptedAuth });

    stubFetch((url) => handleDns(url) ?? new Response(null, { status: 401 }));
    await expect(testServer(env, "user_free", id)).rejects.toMatchObject({ status: 401 });
    const row = await getRow(id);
    expect(row?.status).toBe("requires_auth");
  });

  it("records failures as status=error with a sanitized message", async () => {
    const id = await seedServerRow("user_free");
    stubFetch(
      (url) =>
        handleDns(url) ??
        new Response("oops token=fake_secret_token_abcdefghijklmnopqrstuvwxyz", { status: 500 }),
    );
    await expect(testServer(env, "user_free", id)).rejects.toMatchObject({ status: 502 });
    const row = await getRow(id);
    expect(row?.status).toBe("error");
    expect(row?.lastError).not.toContain("fake_secret_token_abcdefghijklmnopqrstuvwxyz");
  });

  it("returns 404 when testing someone else's server", async () => {
    const id = await seedServerRow("user_free");
    await expect(testServer(env, "user_other", id)).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// reconnectServer / deleteServer
// ---------------------------------------------------------------------------

describe("reconnectServer", () => {
  it("re-marks a no-auth server as connected without consuming quota", async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedServerRow("user_free", { url: `https://full-${i}.example.com/mcp` });
    }
    const target = (await listServers(db, "user_free"))[0];
    stubPublicNoAuthServer();

    const result = await reconnectServer(env, "user_free", ORIGIN, target.id);
    expect(result.type).toBe("connected");
    expect((await listServers(db, "user_free")).length).toBe(3);
  });

  it("opens an OAuth transaction bound to the existing row when auth is required", async () => {
    const id = await seedServerRow("user_free", {
      url: "https://mcp.example.com/mcp",
      status: "requires_auth",
      authType: "oauth",
    });
    stubOAuthDiscovery();

    const result = await reconnectServer(env, "user_free", ORIGIN, id);
    expect(result.type).toBe("authorization_required");
    if (result.type !== "authorization_required") return;

    const state = new URL(result.authorizationUrl).searchParams.get("state")!;
    const tx = await db.query.mcpOauthTransaction.findFirst({
      where: eq(mcpOauthTransaction.id, state),
    });
    const payload = await decryptJson<{ serverId?: string }>(env, tx!.encryptedPayload);
    expect(payload.serverId).toBe(id);
  });

  it("returns 404 for other users' servers", async () => {
    const id = await seedServerRow("user_free");
    await expect(reconnectServer(env, "user_other", ORIGIN, id)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("deleteServer", () => {
  it("deletes the owner's server", async () => {
    const id = await seedServerRow("user_free");
    await deleteServer(env, "user_free", id);
    expect(await getRow(id)).toBeUndefined();
  });

  it("returns 404 when deleting another user's server", async () => {
    const id = await seedServerRow("user_free");
    await expect(deleteServer(env, "user_other", id)).rejects.toMatchObject({ status: 404 });
    expect(await getRow(id)).toBeTruthy();
  });

  it("cascades removal when the user is deleted", async () => {
    const id = await seedServerRow("user_free");
    // Direct delete to verify the FK cascade defined in the migration.
    await db.run(sql`delete from user where id = 'user_free'`);
    expect(await getRow(id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DTO hygiene
// ---------------------------------------------------------------------------

describe("listServers", () => {
  it("never exposes encrypted credentials in DTOs", async () => {
    const encryptedAuth = await encryptJson(env, { tokens: { accessToken: "hidden" } });
    await seedServerRow("user_free", { authType: "oauth", encryptedAuth });

    const servers = await listServers(db, "user_free");
    expect(servers).toHaveLength(1);
    const serialized = JSON.stringify(servers[0]);
    expect(serialized).not.toContain("hidden");
    expect(serialized).not.toContain(encryptedAuth);
    expect("encryptedAuth" in servers[0]).toBe(false);
  });
});
