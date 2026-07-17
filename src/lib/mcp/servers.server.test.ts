import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DB } from "#/db";
import { mcpAuthSession } from "#/db/schema";
import { MCP_ERROR_CODES, MCP_FREE_SERVER_LIMIT } from "./config";
import { decryptJson, importEncryptionKey } from "./crypto.server";
import type { McpAuthData } from "./oauth.server";
import {
  beginServerConnection,
  completeOauthCallback,
  consumeAuthSession,
  disconnectServer,
  getServerForUser,
  insertServerWithLimit,
  listServersWithUsage,
  McpServerLimitError,
  testServerConnection,
  updateServerDetails,
  type McpContext,
} from "./servers.server";
import { createTestContext, createTestDb, createTestUser, TEST_ENCRYPTION_KEY } from "./test-utils";

const ORIGIN = "https://app.example.com";

let db: DB;
let ctx: McpContext;

beforeEach(async () => {
  db = createTestDb();
  ctx = createTestContext(db);
  await createTestUser(db, "user_a");
  await createTestUser(db, "user_b");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function insertInput(userId: string, index: number, unlimited = false) {
  return {
    userId,
    unlimited,
    name: `Server ${index}`,
    serverUrl: `https://mcp-${index}.example.com/mcp`,
    status: "connected",
    authType: "none",
    oauthConfig: null,
    authData: null,
    serverInfo: null,
    lastConnectedAt: new Date(),
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function initializeResponse(name = "test-server") {
  return jsonResponse({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      serverInfo: { name, version: "1.2.3" },
    },
  });
}

function stubFetchRoutes(routes: Record<string, (init?: RequestInit) => Response>) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input).split("?")[0];
    const handler = routes[url];
    return handler ? handler(init) : new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("three-server limit", () => {
  it("allows free users up to the limit and then rejects atomically", async () => {
    for (let index = 0; index < MCP_FREE_SERVER_LIMIT; index += 1) {
      await insertServerWithLimit(db, insertInput("user_a", index));
    }

    const error = await insertServerWithLimit(db, insertInput("user_a", 99)).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(McpServerLimitError);
    expect(error).toMatchObject({
      status: 403,
      details: { code: MCP_ERROR_CODES.limitReached, limit: MCP_FREE_SERVER_LIMIT },
    });
  });

  it("the limit is per user", async () => {
    for (let index = 0; index < MCP_FREE_SERVER_LIMIT; index += 1) {
      await insertServerWithLimit(db, insertInput("user_a", index));
    }
    await expect(insertServerWithLimit(db, insertInput("user_b", 0))).resolves.toMatchObject({
      userId: "user_b",
    });
  });

  it("paying users are unlimited", async () => {
    for (let index = 0; index < MCP_FREE_SERVER_LIMIT + 3; index += 1) {
      await insertServerWithLimit(db, insertInput("user_a", index, true));
    }
    const { usage } = await listServersWithUsage(
      createTestContext(db, { isUnlimited: () => Promise.resolve(true) }),
      "user_a",
    );
    expect(usage).toEqual({ used: MCP_FREE_SERVER_LIMIT + 3, limit: null, unlimited: true });
  });

  it("beginServerConnection rejects at the limit before contacting the server", async () => {
    for (let index = 0; index < MCP_FREE_SERVER_LIMIT; index += 1) {
      await insertServerWithLimit(db, insertInput("user_a", index));
    }
    const fetchMock = stubFetchRoutes({});

    await expect(
      beginServerConnection(
        ctx,
        "user_a",
        { name: "One too many", serverUrl: "https://mcp-extra.example.com/mcp" },
        ORIGIN,
      ),
    ).rejects.toBeInstanceOf(McpServerLimitError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate URLs for the same user with a 409", async () => {
    await insertServerWithLimit(db, insertInput("user_a", 1));
    await expect(insertServerWithLimit(db, insertInput("user_a", 1))).rejects.toMatchObject({
      status: 409,
      details: { code: MCP_ERROR_CODES.duplicateServer },
    });
  });
});

describe("authorization", () => {
  it("does not leak other users' servers", async () => {
    const row = await insertServerWithLimit(db, insertInput("user_a", 1));

    await expect(getServerForUser(db, "user_b", row.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      updateServerDetails(ctx, "user_b", row.id, { name: "hijack" }, ORIGIN),
    ).rejects.toMatchObject({ status: 404 });
    await expect(disconnectServer(ctx, "user_b", row.id)).rejects.toMatchObject({ status: 404 });
    await expect(testServerConnection(ctx, "user_b", row.id)).rejects.toMatchObject({
      status: 404,
    });

    // Still owned and intact.
    await expect(getServerForUser(db, "user_a", row.id)).resolves.toMatchObject({ id: row.id });
  });

  it("rejects an OAuth callback initiated by a different account", async () => {
    const row = await insertServerWithLimit(db, insertInput("user_a", 1));
    await db.insert(mcpAuthSession).values({
      state: "state-1",
      serverId: row.id,
      userId: "user_a",
      codeVerifier: "enc",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      completeOauthCallback(ctx, "user_b", { state: "state-1", code: "c", error: null }, ORIGIN),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("domain logic", () => {
  it("lists sanitized servers without any credential material", async () => {
    await insertServerWithLimit(db, {
      ...insertInput("user_a", 1),
      authType: "oauth",
      oauthConfig: JSON.stringify({ clientId: "client-1" }),
      authData: "v1.encrypted.blob",
    });

    const { servers, usage } = await listServersWithUsage(ctx, "user_a");
    expect(usage).toEqual({ used: 1, limit: MCP_FREE_SERVER_LIMIT, unlimited: false });
    expect(servers).toHaveLength(1);
    const serialized = JSON.stringify(servers);
    expect(serialized).not.toContain("authData");
    expect(serialized).not.toContain("encrypted.blob");
    expect(serialized).not.toContain("client-1");
    expect(servers[0]).toMatchObject({ name: "Server 1", status: "connected", authType: "oauth" });
  });

  it("renames a server without touching credentials", async () => {
    const row = await insertServerWithLimit(db, insertInput("user_a", 1));
    const { server, authorizationUrl } = await updateServerDetails(
      ctx,
      "user_a",
      row.id,
      { name: "Renamed" },
      ORIGIN,
    );
    expect(server.name).toBe("Renamed");
    expect(authorizationUrl).toBeNull();
  });

  it("rejects invalid names and URLs with 400", async () => {
    const row = await insertServerWithLimit(db, insertInput("user_a", 1));
    await expect(
      updateServerDetails(ctx, "user_a", row.id, { name: "  " }, ORIGIN),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      updateServerDetails(ctx, "user_a", row.id, { name: "x".repeat(61) }, ORIGIN),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      beginServerConnection(ctx, "user_a", { name: "ok", serverUrl: "http://10.0.0.1" }, ORIGIN),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("disconnecting removes the server and its pending auth sessions", async () => {
    const row = await insertServerWithLimit(db, insertInput("user_a", 1));
    await db.insert(mcpAuthSession).values({
      state: "state-1",
      serverId: row.id,
      userId: "user_a",
      codeVerifier: "enc",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await disconnectServer(ctx, "user_a", row.id);

    expect(await db.query.mcpServer.findFirst()).toBeUndefined();
    expect(await db.query.mcpAuthSession.findFirst()).toBeUndefined();
  });

  it("auth sessions are single-use and expire", async () => {
    const row = await insertServerWithLimit(db, insertInput("user_a", 1));
    await db.insert(mcpAuthSession).values([
      {
        state: "valid",
        serverId: row.id,
        userId: "user_a",
        codeVerifier: "enc",
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        state: "expired",
        serverId: row.id,
        userId: "user_a",
        codeVerifier: "enc",
        expiresAt: new Date(Date.now() - 1_000),
      },
    ]);

    expect(await consumeAuthSession(db, "valid")).toMatchObject({ serverId: row.id });
    expect(await consumeAuthSession(db, "valid")).toBeNull();
    expect(await consumeAuthSession(db, "expired")).toBeNull();
    expect(await consumeAuthSession(db, "unknown")).toBeNull();
  });
});

describe("connection flows (stubbed network)", () => {
  it("connects an unauthenticated server directly", async () => {
    stubFetchRoutes({
      "https://open.example.com/mcp": () => initializeResponse("open-server"),
    });

    const result = await beginServerConnection(
      ctx,
      "user_a",
      { name: "Open server", serverUrl: "https://open.example.com/mcp" },
      ORIGIN,
    );

    expect(result.authorizationUrl).toBeNull();
    expect(result.server).toMatchObject({
      status: "connected",
      authType: "none",
      serverInfo: { name: "open-server", version: "1.2.3" },
    });
  });

  it("surfaces unreachable servers as 502 without saving anything", async () => {
    stubFetchRoutes({
      "https://down.example.com/mcp": () => new Response("oops", { status: 500 }),
    });

    await expect(
      beginServerConnection(
        ctx,
        "user_a",
        { name: "Down", serverUrl: "https://down.example.com/mcp" },
        ORIGIN,
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(await db.query.mcpServer.findFirst()).toBeUndefined();
  });

  it("runs the full OAuth flow: discovery, registration, authorization URL, callback", async () => {
    const routes = {
      "https://secure.example.com/mcp": (init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("authorization");
        if (auth === "Bearer at-1") return initializeResponse("secure-server");
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://secure.example.com/.well-known/oauth-protected-resource/mcp"',
          },
        });
      },
      "https://secure.example.com/.well-known/oauth-protected-resource/mcp": () =>
        jsonResponse({
          resource: "https://secure.example.com/mcp",
          authorization_servers: ["https://auth.example.com"],
        }),
      "https://auth.example.com/.well-known/oauth-authorization-server": () =>
        jsonResponse({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
        }),
      "https://auth.example.com/register": () =>
        jsonResponse({ client_id: "client-1", client_secret: "cs-1" }),
      "https://auth.example.com/token": () =>
        jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }),
    };
    stubFetchRoutes(routes);

    const begin = await beginServerConnection(
      ctx,
      "user_a",
      { name: "Secure server", serverUrl: "https://secure.example.com/mcp" },
      ORIGIN,
    );

    expect(begin.server.status).toBe("needs_auth");
    expect(begin.server.authType).toBe("oauth");
    expect(begin.authorizationUrl).toBeTruthy();

    const authorizationUrl = new URL(begin.authorizationUrl ?? "");
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://auth.example.com/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe("client-1");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/api/mcp/oauth/callback`,
    );
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const server = await completeOauthCallback(
      ctx,
      "user_a",
      { state, code: "code-1", error: null },
      ORIGIN,
    );

    expect(server.status).toBe("connected");
    expect(server.serverInfo).toEqual({ name: "secure-server", version: "1.2.3" });

    // Tokens are stored encrypted, never in plaintext.
    const row = await db.query.mcpServer.findFirst();
    expect(row?.authData).toBeTruthy();
    expect(row?.authData).not.toContain("at-1");
    expect(row?.authData).not.toContain("cs-1");
    const key = await importEncryptionKey(TEST_ENCRYPTION_KEY);
    const decrypted = await decryptJson<McpAuthData>(key, row?.authData ?? "");
    expect(decrypted.tokens?.accessToken).toBe("at-1");
    expect(decrypted.clientSecret).toBe("cs-1");
  });

  it("marks a server as needing auth when its token is rejected during a test", async () => {
    const key = await importEncryptionKey(TEST_ENCRYPTION_KEY);
    const { encryptJson } = await import("./crypto.server");
    const row = await insertServerWithLimit(db, {
      ...insertInput("user_a", 1),
      serverUrl: "https://secure.example.com/mcp",
      authType: "oauth",
      status: "connected",
      oauthConfig: JSON.stringify({
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        registrationEndpoint: null,
        scope: null,
        resource: "https://secure.example.com/mcp",
        clientId: "client-1",
      }),
      authData: await encryptJson(key, {
        tokens: { accessToken: "stale", refreshToken: null, expiresAt: null },
      }),
    });

    stubFetchRoutes({
      "https://secure.example.com/mcp": () => new Response(null, { status: 401 }),
    });

    const server = await testServerConnection(ctx, "user_a", row.id);
    expect(server.status).toBe("needs_auth");
    expect(server.lastError).toContain("rejected");
  });

  it("refreshes an expired token before testing", async () => {
    const key = await importEncryptionKey(TEST_ENCRYPTION_KEY);
    const { encryptJson } = await import("./crypto.server");
    const row = await insertServerWithLimit(db, {
      ...insertInput("user_a", 1),
      serverUrl: "https://secure.example.com/mcp",
      authType: "oauth",
      oauthConfig: JSON.stringify({
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        registrationEndpoint: null,
        scope: null,
        resource: "https://secure.example.com/mcp",
        clientId: "client-1",
      }),
      authData: await encryptJson(key, {
        tokens: { accessToken: "stale", refreshToken: "rt-1", expiresAt: Date.now() - 1000 },
      }),
    });

    stubFetchRoutes({
      "https://auth.example.com/token": () =>
        jsonResponse({ access_token: "fresh", expires_in: 3600 }),
      "https://secure.example.com/mcp": (init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("authorization");
        return auth === "Bearer fresh"
          ? initializeResponse("secure-server")
          : new Response(null, { status: 401 });
      },
    });

    const server = await testServerConnection(ctx, "user_a", row.id);
    expect(server.status).toBe("connected");

    // The refreshed token is persisted encrypted; the refresh token is kept.
    const updated = await db.query.mcpServer.findFirst();
    const decrypted = await decryptJson<McpAuthData>(key, updated?.authData ?? "");
    expect(decrypted.tokens?.accessToken).toBe("fresh");
    expect(decrypted.tokens?.refreshToken).toBe("rt-1");
  });

  it("requires the encryption key to be configured for OAuth servers", async () => {
    stubFetchRoutes({
      "https://secure.example.com/mcp": () => new Response(null, { status: 401 }),
    });

    await expect(
      beginServerConnection(
        createTestContext(db, { encryptionSecret: undefined }),
        "user_a",
        { name: "Secure", serverUrl: "https://secure.example.com/mcp" },
        ORIGIN,
      ),
    ).rejects.toMatchObject({ status: 500 });
    // Nothing half-saved.
    expect(await db.query.mcpServer.findFirst()).toBeUndefined();
  });
});
