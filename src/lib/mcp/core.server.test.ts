import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { mcpOauthSession, mcpServer } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import {
  beginAuthorization,
  completeAuthorization,
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  testMcpServer,
  updateMcpServer,
  type McpDeps,
} from "./core.server";
import { decryptJson, encryptJson } from "./crypto.server";
import {
  createDeps,
  createOauthWorld,
  createTestDb,
  publicMcpFetch,
  seedUser,
  TEST_ENCRYPTION_KEY,
  type TestDb,
} from "./test-helpers";

const USER = "user_1";
const OTHER_USER = "user_2";

let testDb: TestDb;

beforeEach(async () => {
  testDb = createTestDb();
  await seedUser(testDb.db, USER);
  await seedUser(testDb.db, OTHER_USER);
});

function deps(fetchFn: typeof fetch = publicMcpFetch()): McpDeps {
  return createDeps(testDb.db, fetchFn);
}

async function catchApiError(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe("createMcpServer", () => {
  it("connects immediately to a server that requires no auth", async () => {
    const result = await createMcpServer(
      deps(publicMcpFetch(4)),
      USER,
      { name: "Docs", serverUrl: "https://mcp.example.com/mcp" },
      { unlimited: false },
    );
    expect(result.requiresAuth).toBe(false);
    expect(result.server).toMatchObject({
      name: "Docs",
      status: "connected",
      authType: "none",
      serverName: "Test MCP",
      toolCount: 4,
    });
    // The API view must never expose auth material or internal metadata.
    expect(Object.keys(result.server)).not.toContain("encryptedAuth");
    expect(Object.keys(result.server)).not.toContain("oauthMetadata");
  });

  it("normalizes the URL and rejects duplicates with 409", async () => {
    await createMcpServer(
      deps(),
      USER,
      { name: "A", serverUrl: "https://mcp.example.com/mcp/" },
      { unlimited: false },
    );
    const error = await catchApiError(
      createMcpServer(
        deps(),
        USER,
        { name: "B", serverUrl: "https://mcp.example.com/mcp" },
        { unlimited: false },
      ),
    );
    expect(error.status).toBe(409);
    expect(error.details?.code).toBe("duplicate_server");
  });

  it("rejects invalid names and unsafe URLs", async () => {
    await expect(
      createMcpServer(
        deps(),
        USER,
        { name: "  ", serverUrl: "https://mcp.example.com/mcp" },
        { unlimited: false },
      ),
    ).rejects.toMatchObject({ status: 400 });
    const error = await catchApiError(
      createMcpServer(
        deps(),
        USER,
        { name: "Internal", serverUrl: "https://10.0.0.1/mcp" },
        { unlimited: false },
      ),
    );
    expect(error.details?.code).toBe("invalid_url");
  });

  it("does not persist a server when the probe fails", async () => {
    const failing = (async () => new Response(null, { status: 500 })) as typeof fetch;
    await expect(
      createMcpServer(
        deps(failing),
        USER,
        { name: "Broken", serverUrl: "https://mcp.example.com/mcp" },
        { unlimited: false },
      ),
    ).rejects.toMatchObject({ status: 502 });
    const list = await listMcpServers(deps(), USER, false);
    expect(list.servers).toHaveLength(0);
  });
});

describe("free plan limit", () => {
  async function createN(count: number, unlimited: boolean) {
    for (let i = 0; i < count; i++) {
      await createMcpServer(
        deps(),
        USER,
        { name: `Server ${i}`, serverUrl: `https://mcp${i}.example.com/mcp` },
        { unlimited },
      );
    }
  }

  it("allows exactly three servers for free users", async () => {
    await createN(3, false);
    const error = await catchApiError(
      createMcpServer(
        deps(),
        USER,
        { name: "Fourth", serverUrl: "https://mcp4.example.com/mcp" },
        { unlimited: false },
      ),
    );
    expect(error.status).toBe(403);
    expect(error.details?.code).toBe("server_limit_reached");
    const list = await listMcpServers(deps(), USER, false);
    expect(list.servers).toHaveLength(3);
    expect(list.limit).toEqual({ max: 3, used: 3, canAdd: false });
  });

  it("enforces the limit even when the pre-check is raced", async () => {
    await createN(2, false);
    // Simulate a concurrent insert landing between pre-check and insert by
    // giving the user a third row directly.
    await testDb.db.insert(mcpServer).values({
      id: "mcp_race",
      userId: USER,
      name: "Raced",
      serverUrl: "https://raced.example.com/mcp",
      status: "connected",
      authType: "none",
    });
    const error = await catchApiError(
      createMcpServer(
        deps(),
        USER,
        { name: "Fourth", serverUrl: "https://mcp4.example.com/mcp" },
        { unlimited: false },
      ),
    );
    expect(error.details?.code).toBe("server_limit_reached");
    const list = await listMcpServers(deps(), USER, false);
    expect(list.servers).toHaveLength(3);
  });

  it("does not limit paying users", async () => {
    await createN(5, true);
    const list = await listMcpServers(deps(), USER, true);
    expect(list.servers).toHaveLength(5);
    expect(list.limit).toEqual({ max: null, used: 5, canAdd: true });
  });

  it("scopes the limit per user", async () => {
    await createN(3, false);
    const result = await createMcpServer(
      deps(),
      OTHER_USER,
      { name: "Mine", serverUrl: "https://mcp9.example.com/mcp" },
      { unlimited: false },
    );
    expect(result.server.status).toBe("connected");
  });
});

describe("authorization (ownership)", () => {
  it("hides other users' servers from every operation", async () => {
    const { server } = await createMcpServer(
      deps(),
      USER,
      { name: "Mine", serverUrl: "https://mcp.example.com/mcp" },
      { unlimited: false },
    );

    for (const attempt of [
      updateMcpServer(deps(), OTHER_USER, server.id, { name: "Stolen" }),
      deleteMcpServer(deps(), OTHER_USER, server.id),
      testMcpServer(deps(), OTHER_USER, server.id),
      beginAuthorization(deps(), OTHER_USER, server.id, "https://app.example.com"),
    ]) {
      const error = await catchApiError(attempt);
      expect(error.status).toBe(404);
      expect(error.details?.code).toBe("not_found");
    }

    // And the row is untouched.
    const list = await listMcpServers(deps(), USER, false);
    expect(list.servers[0].name).toBe("Mine");
  });
});

describe("update and delete", () => {
  it("renames without touching connection state", async () => {
    const { server } = await createMcpServer(
      deps(),
      USER,
      { name: "Old", serverUrl: "https://mcp.example.com/mcp" },
      { unlimited: false },
    );
    const result = await updateMcpServer(deps(), USER, server.id, { name: "New" });
    expect(result.server.name).toBe("New");
    expect(result.server.status).toBe("connected");
    expect(result.requiresAuth).toBe(false);
  });

  it("resets stored auth when the URL changes", async () => {
    const world = createOauthWorld();
    const { server } = await createMcpServer(
      deps(world.fetchFn),
      USER,
      { name: "OAuth server", serverUrl: "https://mcp.example.com/mcp" },
      { unlimited: false },
    );
    // Give it stored auth to prove it gets wiped.
    await testDb.db
      .update(mcpServer)
      .set({ encryptedAuth: await encryptJson(TEST_ENCRYPTION_KEY, { accessToken: "tok" }) })
      .where(eq(mcpServer.id, server.id));

    const result = await updateMcpServer(deps(publicMcpFetch()), USER, server.id, {
      serverUrl: "https://other.example.com/mcp",
    });
    expect(result.server.serverUrl).toBe("https://other.example.com/mcp");
    expect(result.server.status).toBe("connected");
    const row = await testDb.db.query.mcpServer.findFirst({
      where: eq(mcpServer.id, server.id),
    });
    expect(row?.encryptedAuth).toBeNull();
  });

  it("deletes servers and their pending oauth sessions", async () => {
    const world = createOauthWorld();
    const { server } = await createMcpServer(
      deps(world.fetchFn),
      USER,
      { name: "OAuth server", serverUrl: "https://mcp.example.com/mcp" },
      { unlimited: false },
    );
    await beginAuthorization(deps(world.fetchFn), USER, server.id, "https://app.example.com");
    await deleteMcpServer(deps(), USER, server.id);
    expect(
      await testDb.db.query.mcpServer.findFirst({ where: eq(mcpServer.id, server.id) }),
    ).toBeUndefined();
    expect(
      await testDb.db.query.mcpOauthSession.findFirst({
        where: eq(mcpOauthSession.serverId, server.id),
      }),
    ).toBeUndefined();
  });
});

describe("oauth flow", () => {
  async function createPendingServer(world = createOauthWorld()) {
    const result = await createMcpServer(
      deps(world.fetchFn),
      USER,
      { name: "Linear", serverUrl: "https://mcp.example.com/mcp" },
      { unlimited: false },
    );
    return { world, server: result.server, requiresAuth: result.requiresAuth };
  }

  it("marks OAuth servers as pending and begins authorization with PKCE", async () => {
    const { world, server, requiresAuth } = await createPendingServer();
    expect(requiresAuth).toBe(true);
    expect(server.status).toBe("pending_auth");
    expect(server.authType).toBe("oauth");

    const { authorizationUrl } = await beginAuthorization(
      deps(world.fetchFn),
      USER,
      server.id,
      "https://app.example.com",
    );
    const url = new URL(authorizationUrl);
    expect(url.origin).toBe("https://auth.example.com");
    expect(url.searchParams.get("client_id")).toBe("client-abc");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/api/mcp/oauth/callback",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();

    const session = await testDb.db.query.mcpOauthSession.findFirst({
      where: eq(mcpOauthSession.id, state as string),
    });
    expect(session?.userId).toBe(USER);
    // The PKCE verifier is encrypted, not stored in the clear.
    expect(session?.encryptedPayload.startsWith("v1.")).toBe(true);
  });

  it("completes authorization, encrypts tokens at rest, and connects", async () => {
    const { world, server } = await createPendingServer();
    const { authorizationUrl } = await beginAuthorization(
      deps(world.fetchFn),
      USER,
      server.id,
      "https://app.example.com",
    );
    const state = new URL(authorizationUrl).searchParams.get("state") as string;

    const result = await completeAuthorization(deps(world.fetchFn), USER, {
      state,
      code: "good-code",
    });
    expect(result.serverId).toBe(server.id);

    const row = await testDb.db.query.mcpServer.findFirst({ where: eq(mcpServer.id, server.id) });
    expect(row?.status).toBe("connected");
    expect(row?.toolCount).toBe(3);
    // Token is stored encrypted: the raw column must not contain it...
    expect(row?.encryptedAuth).toBeTruthy();
    expect(row?.encryptedAuth).not.toContain(world.state.accessToken);
    // ...but it decrypts with the configured key.
    const auth = await decryptJson<{ accessToken: string; refreshToken: string }>(
      TEST_ENCRYPTION_KEY,
      row?.encryptedAuth as string,
    );
    expect(auth.accessToken).toBe(world.state.accessToken);
    expect(auth.refreshToken).toBe(world.state.refreshToken);

    // The state is single-use.
    const replay = await catchApiError(
      completeAuthorization(deps(world.fetchFn), USER, { state, code: "good-code" }),
    );
    expect(replay.details?.code).toBe("oauth_state_invalid");
  });

  it("rejects a callback state that belongs to another user", async () => {
    const { world, server } = await createPendingServer();
    const { authorizationUrl } = await beginAuthorization(
      deps(world.fetchFn),
      USER,
      server.id,
      "https://app.example.com",
    );
    const state = new URL(authorizationUrl).searchParams.get("state") as string;
    const error = await catchApiError(
      completeAuthorization(deps(world.fetchFn), OTHER_USER, { state, code: "good-code" }),
    );
    expect(error.details?.code).toBe("oauth_state_invalid");
    // The session must survive for the legitimate user.
    expect(
      await testDb.db.query.mcpOauthSession.findFirst({ where: eq(mcpOauthSession.id, state) }),
    ).toBeTruthy();
  });

  it("rejects expired authorization sessions", async () => {
    const { world, server } = await createPendingServer();
    const { authorizationUrl } = await beginAuthorization(
      deps(world.fetchFn),
      USER,
      server.id,
      "https://app.example.com",
    );
    const state = new URL(authorizationUrl).searchParams.get("state") as string;
    await testDb.db
      .update(mcpOauthSession)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mcpOauthSession.id, state));
    const error = await catchApiError(
      completeAuthorization(deps(world.fetchFn), USER, { state, code: "good-code" }),
    );
    expect(error.details?.code).toBe("oauth_state_invalid");
  });

  it("keeps the server pending when the token exchange fails", async () => {
    const { world, server } = await createPendingServer();
    const { authorizationUrl } = await beginAuthorization(
      deps(world.fetchFn),
      USER,
      server.id,
      "https://app.example.com",
    );
    const state = new URL(authorizationUrl).searchParams.get("state") as string;
    const error = await catchApiError(
      completeAuthorization(deps(world.fetchFn), USER, { state, code: "wrong-code" }),
    );
    expect(error.details?.code).toBe("oauth_exchange_failed");
    const row = await testDb.db.query.mcpServer.findFirst({ where: eq(mcpServer.id, server.id) });
    expect(row?.status).toBe("pending_auth");
    expect(row?.encryptedAuth).toBeNull();
  });
});

describe("testMcpServer", () => {
  it("reports latency and refreshes state on success", async () => {
    const { server } = await createMcpServer(
      deps(publicMcpFetch(1)),
      USER,
      { name: "Docs", serverUrl: "https://mcp.example.com/mcp" },
      { unlimited: false },
    );
    const result = await testMcpServer(deps(publicMcpFetch(7)), USER, server.id);
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.server.status).toBe("connected");
    expect(result.server.toolCount).toBe(7);
  });

  it("marks the server as error when it stops responding", async () => {
    const { server } = await createMcpServer(
      deps(),
      USER,
      { name: "Docs", serverUrl: "https://mcp.example.com/mcp" },
      { unlimited: false },
    );
    const failing = (async () => new Response(null, { status: 503 })) as typeof fetch;
    const result = await testMcpServer(deps(failing), USER, server.id);
    expect(result.ok).toBe(false);
    expect(result.server.status).toBe("error");
    expect(result.server.lastError).toBeTruthy();
  });

  it("moves to pending_auth when the server starts demanding authorization", async () => {
    const { server } = await createMcpServer(
      deps(),
      USER,
      { name: "Docs", serverUrl: "https://mcp.example.com/mcp" },
      { unlimited: false },
    );
    const world = createOauthWorld();
    const result = await testMcpServer(deps(world.fetchFn), USER, server.id);
    expect(result.ok).toBe(false);
    expect(result.server.status).toBe("pending_auth");
  });

  it("refreshes an expired token before probing", async () => {
    const world = createOauthWorld();
    const { server } = await createMcpServer(
      deps(world.fetchFn),
      USER,
      { name: "OAuth", serverUrl: "https://mcp.example.com/mcp" },
      { unlimited: false },
    );
    await testDb.db
      .update(mcpServer)
      .set({
        encryptedAuth: await encryptJson(TEST_ENCRYPTION_KEY, {
          accessToken: "stale-token",
          tokenType: "Bearer",
          refreshToken: world.state.refreshToken,
          expiresAt: Date.now() - 60_000,
          clientId: world.state.clientId,
          tokenEndpoint: "https://auth.example.com/token",
          resource: "https://mcp.example.com/mcp",
        }),
      })
      .where(eq(mcpServer.id, server.id));

    const result = await testMcpServer(deps(world.fetchFn), USER, server.id);
    expect(world.state.refreshCalls).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.server.status).toBe("connected");

    const row = await testDb.db.query.mcpServer.findFirst({ where: eq(mcpServer.id, server.id) });
    const auth = await decryptJson<{ accessToken: string }>(
      TEST_ENCRYPTION_KEY,
      row?.encryptedAuth as string,
    );
    expect(auth.accessToken).toBe(world.state.refreshedAccessToken);
  });

  it("requires reconnecting when the token is expired and cannot be refreshed", async () => {
    const world = createOauthWorld();
    const { server } = await createMcpServer(
      deps(world.fetchFn),
      USER,
      { name: "OAuth", serverUrl: "https://mcp.example.com/mcp" },
      { unlimited: false },
    );
    await testDb.db
      .update(mcpServer)
      .set({
        encryptedAuth: await encryptJson(TEST_ENCRYPTION_KEY, {
          accessToken: "stale-token",
          tokenType: "Bearer",
          expiresAt: Date.now() - 60_000,
          clientId: world.state.clientId,
          tokenEndpoint: "https://auth.example.com/token",
          resource: "https://mcp.example.com/mcp",
        }),
      })
      .where(eq(mcpServer.id, server.id));

    const result = await testMcpServer(deps(world.fetchFn), USER, server.id);
    expect(result.ok).toBe(false);
    expect(result.server.status).toBe("pending_auth");
    expect(result.server.lastError).toContain("Reconnect");
  });
});
