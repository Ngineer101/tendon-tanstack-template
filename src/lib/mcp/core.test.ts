import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "#/db";
import {
  billingAccount,
  creditBalance,
  mcpOauthSession,
  mcpServer,
  subscription,
  user,
} from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import { eq } from "drizzle-orm";
import type { McpServerEnv } from "./config.server";
import {
  assertCanAddServer,
  createMcpServer,
  deleteMcpServer,
  handleOauthCallback,
  listMcpServers,
  reconnectMcpServer,
  testMcpServer,
  toPublicServer,
  updateMcpServer,
} from "./core.server";
import { decryptJson, encryptJson } from "./crypto.server";
import type { McpAuthData } from "./oauth.server";
import { createTestD1, TEST_ENCRYPTION_KEY } from "./testing/d1-shim";

const ORIGIN = "https://app.example.com";
const SERVER_URL = "https://mcp.example.com/mcp";

function requestBody(init?: RequestInit): { method: string; id?: number } {
  return JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
    method: string;
    id?: number;
  };
}

function requestHeader(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

const AUTH_METADATA = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  registration_endpoint: "https://auth.example.com/register",
};

let env: McpServerEnv;
let db: ReturnType<typeof getDb>;

async function seedUser(id: string) {
  await db.insert(user).values({ id, name: id, email: `${id}@example.com` });
}

async function seedServers(userId: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    await db.insert(mcpServer).values({
      id: `mcp_${userId}_${i}`,
      userId,
      name: `Server ${i}`,
      url: `https://server-${i}.example.com/mcp`,
      status: "connected",
    });
  }
}

async function upgradeToPro(userId: string) {
  await db.insert(billingAccount).values({ id: `billing_${userId}`, userId });
  await db.insert(creditBalance).values({ billingAccountId: `billing_${userId}` });
  await db.insert(subscription).values({
    id: `subscription_${userId}`,
    billingAccountId: `billing_${userId}`,
    stripeSubscriptionId: `sub_${userId}`,
    plan: "pro_monthly",
    status: "active",
  });
}

/** Fetch stub for a no-auth MCP server that answers the handshake. */
function stubOpenServer(toolCount = 2) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = requestBody(init);
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result =
      body.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "open-server", version: "0.1.0" },
            capabilities: {},
          }
        : { tools: Array.from({ length: toolCount }, (_, i) => ({ name: `tool_${i}` })) };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

/** Fetch stub covering the full OAuth discovery + registration chain. */
function stubOauthServer(options: { tokenResponse?: () => Response } = {}) {
  const calls: string[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === SERVER_URL && init?.method === "POST") {
      const body = requestBody(init);
      const auth = requestHeader(init, "authorization");
      if (!auth) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "secure-server", version: "2.0.0" },
              capabilities: {},
            }
          : { tools: [{ name: "secure_tool" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") {
      return Response.json({
        resource: SERVER_URL,
        authorization_servers: ["https://auth.example.com"],
      });
    }
    if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
      return Response.json(AUTH_METADATA);
    }
    if (url === "https://auth.example.com/register") {
      return Response.json({ client_id: "client-abc" }, { status: 201 });
    }
    if (url === "https://auth.example.com/token") {
      return (
        options.tokenResponse?.() ??
        Response.json({
          access_token: "access-token-1",
          refresh_token: "refresh-token-1",
          expires_in: 3600,
        })
      );
    }
    return new Response("not found", { status: 404 });
  });
  return { mock, calls };
}

async function getRow(id: string) {
  const row = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, id) });
  if (!row) throw new Error(`Missing row ${id}`);
  return row;
}

beforeEach(() => {
  env = { DB: createTestD1(), MCP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY } as unknown as McpServerEnv;
  db = getDb(env.DB);
});

afterEach(() => vi.unstubAllGlobals());

describe("three-server limit", () => {
  it("allows free users below the limit", async () => {
    await seedUser("u1");
    await seedServers("u1", 2);
    await expect(assertCanAddServer(env, "u1")).resolves.toBeUndefined();
  });

  it("blocks free users at exactly 3 servers", async () => {
    await seedUser("u1");
    await seedServers("u1", 3);
    const failure = await assertCanAddServer(env, "u1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(403);
    expect((failure as ApiError).details?.code).toBe("limit_reached");
    expect((failure as ApiError).details?.limit).toBe(3);
  });

  it("enforces the limit in createMcpServer before any network call", async () => {
    await seedUser("u1");
    await seedServers("u1", 3);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const failure = await createMcpServer(env, "u1", ORIGIN, { url: SERVER_URL }).catch(
      (error: unknown) => error,
    );
    expect((failure as ApiError).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows paying users beyond the limit via the billing entitlement", async () => {
    await seedUser("u1");
    await upgradeToPro("u1");
    await seedServers("u1", 5);
    await expect(assertCanAddServer(env, "u1")).resolves.toBeUndefined();

    vi.stubGlobal("fetch", stubOpenServer());
    const result = await createMcpServer(env, "u1", ORIGIN, { url: SERVER_URL });
    expect(result.requiresAuth).toBe(false);
    expect(result.server.status).toBe("connected");
  });

  it("applies the limit per user, not globally", async () => {
    await seedUser("u1");
    await seedUser("u2");
    await seedServers("u1", 3);
    await expect(assertCanAddServer(env, "u2")).resolves.toBeUndefined();
  });
});

describe("createMcpServer", () => {
  it("connects no-auth servers after a successful handshake", async () => {
    await seedUser("u1");
    vi.stubGlobal("fetch", stubOpenServer(4));
    const result = await createMcpServer(env, "u1", ORIGIN, { url: SERVER_URL, name: "Tools" });
    expect(result.server).toMatchObject({
      name: "Tools",
      status: "connected",
      authType: "none",
      serverName: "open-server",
      toolCount: 4,
    });
  });

  it("rejects duplicate URLs per user", async () => {
    await seedUser("u1");
    vi.stubGlobal("fetch", stubOpenServer());
    await createMcpServer(env, "u1", ORIGIN, { url: SERVER_URL });
    const failure = await createMcpServer(env, "u1", ORIGIN, { url: SERVER_URL }).catch(
      (error: unknown) => error,
    );
    expect((failure as ApiError).status).toBe(409);
  });

  it("rejects SSRF targets before touching the network", async () => {
    await seedUser("u1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const failure = await createMcpServer(env, "u1", ORIGIN, {
      url: "https://169.254.169.254/latest/meta-data",
    }).catch((error: unknown) => error);
    expect((failure as ApiError).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs discovery + registration for OAuth servers and returns an authorization URL", async () => {
    await seedUser("u1");
    const { mock, calls } = stubOauthServer();
    vi.stubGlobal("fetch", mock);

    const result = await createMcpServer(env, "u1", ORIGIN, { url: SERVER_URL });
    expect(result.requiresAuth).toBe(true);
    expect(result.server.status).toBe("pending_auth");

    const authorizationUrl = new URL(result.authorizationUrl!);
    expect(authorizationUrl.origin).toBe("https://auth.example.com");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("client-abc");
    expect(authorizationUrl.searchParams.get("resource")).toBe(SERVER_URL);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");

    // Client registration happened exactly once and auth material is encrypted.
    expect(calls.filter((call) => call.includes("/register"))).toHaveLength(1);
    const row = await getRow(result.server.id);
    expect(row.encryptedAuthData).toBeTruthy();
    expect(row.encryptedAuthData).not.toContain("client-abc");
    const auth = await decryptJson<McpAuthData>(env, row.encryptedAuthData!);
    expect(auth.clientId).toBe("client-abc");
  });
});

describe("OAuth callback", () => {
  async function createPendingServer() {
    const { mock, calls } = stubOauthServer();
    vi.stubGlobal("fetch", mock);
    const created = await createMcpServer(env, "u1", ORIGIN, { url: SERVER_URL });
    const oauthSession = await db.query.mcpOauthSession.findFirst({
      where: eq(mcpOauthSession.serverId, created.server.id),
    });
    return { created, state: oauthSession!.state, calls };
  }

  it("completes the flow: exchanges the code, stores encrypted tokens, connects", async () => {
    await seedUser("u1");
    const { created, state } = await createPendingServer();

    const outcome = await handleOauthCallback(env, "u1", ORIGIN, { state, code: "auth-code" });
    expect(outcome).toEqual({ result: "connected", serverId: created.server.id });

    const row = await getRow(created.server.id);
    expect(row.status).toBe("connected");
    expect(row.serverName).toBe("secure-server");
    expect(row.toolCount).toBe(1);
    expect(row.encryptedAuthData).not.toContain("access-token-1");
    const auth = await decryptJson<McpAuthData>(env, row.encryptedAuthData!);
    expect(auth.accessToken).toBe("access-token-1");
    expect(auth.refreshToken).toBe("refresh-token-1");

    // The OAuth session is single-use and has been consumed.
    const remaining = await db.query.mcpOauthSession.findMany({
      where: eq(mcpOauthSession.serverId, created.server.id),
    });
    expect(remaining).toHaveLength(0);
  });

  it("rejects unknown or foreign state values", async () => {
    await seedUser("u1");
    await seedUser("u2");
    const { state } = await createPendingServer();
    expect(await handleOauthCallback(env, "u1", ORIGIN, { state: "nope", code: "x" })).toEqual({
      result: "error",
      reason: "invalid_state",
    });
    // State belongs to u1: a different signed-in user cannot redeem it.
    expect(await handleOauthCallback(env, "u2", ORIGIN, { state, code: "x" })).toEqual({
      result: "error",
      reason: "invalid_state",
    });
  });

  it("maps access_denied to a cancelled outcome", async () => {
    await seedUser("u1");
    const { state } = await createPendingServer();
    const outcome = await handleOauthCallback(env, "u1", ORIGIN, {
      state,
      error: "access_denied",
    });
    expect(outcome).toEqual({ result: "cancelled" });
  });

  it("rejects expired OAuth sessions", async () => {
    await seedUser("u1");
    const { created, state } = await createPendingServer();
    await db
      .update(mcpOauthSession)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mcpOauthSession.serverId, created.server.id));
    expect(await handleOauthCallback(env, "u1", ORIGIN, { state, code: "x" })).toEqual({
      result: "error",
      reason: "expired",
    });
  });
});

describe("testMcpServer", () => {
  it("refreshes expired tokens and persists the rotation", async () => {
    await seedUser("u1");
    let tokenCalls = 0;
    const { mock } = stubOauthServer({
      tokenResponse: () => {
        tokenCalls += 1;
        // First call is the code exchange, later calls are refreshes. The
        // provider rotates the access token but not the refresh token.
        return tokenCalls === 1
          ? Response.json({
              access_token: "access-token-1",
              refresh_token: "refresh-token-1",
              expires_in: 3600,
            })
          : Response.json({ access_token: "access-token-2", expires_in: 3600 });
      },
    });
    vi.stubGlobal("fetch", mock);
    const created = await createMcpServer(env, "u1", ORIGIN, { url: SERVER_URL });
    const oauthSession = await db.query.mcpOauthSession.findFirst({
      where: eq(mcpOauthSession.serverId, created.server.id),
    });
    await handleOauthCallback(env, "u1", ORIGIN, { state: oauthSession!.state, code: "c" });

    // Force the stored token to be expired.
    const row = await getRow(created.server.id);
    const auth = await decryptJson<McpAuthData>(env, row.encryptedAuthData!);
    await db
      .update(mcpServer)
      .set({
        encryptedAuthData: await encryptJson(env, { ...auth, expiresAt: Date.now() - 1000 }),
      })
      .where(eq(mcpServer.id, row.id));

    const result = await testMcpServer(env, "u1", created.server.id);
    expect(result.server.status).toBe("connected");
    const rotated = await decryptJson<McpAuthData>(env, (await getRow(row.id)).encryptedAuthData!);
    expect(rotated.accessToken).toBe("access-token-2");
    // The provider did not rotate the refresh token; the old one is kept.
    expect(rotated.refreshToken).toBe("refresh-token-1");
  });

  it("marks the server auth_expired when the refresh grant is rejected", async () => {
    await seedUser("u1");
    const { mock } = stubOauthServer({
      tokenResponse: () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    });
    vi.stubGlobal("fetch", mock);
    const created = await createMcpServer(env, "u1", ORIGIN, { url: SERVER_URL });

    // Seed an expired token directly (as if a previous flow completed).
    const row = await getRow(created.server.id);
    const auth = await decryptJson<McpAuthData>(env, row.encryptedAuthData!);
    await db
      .update(mcpServer)
      .set({
        status: "connected",
        encryptedAuthData: await encryptJson(env, {
          ...auth,
          accessToken: "old-token",
          refreshToken: "old-refresh",
          expiresAt: Date.now() - 1000,
        }),
      })
      .where(eq(mcpServer.id, row.id));

    const failure = await testMcpServer(env, "u1", created.server.id).catch(
      (error: unknown) => error,
    );
    expect((failure as ApiError).status).toBe(401);
    expect((failure as ApiError).details?.code).toBe("reconnect_required");
    expect((await getRow(row.id)).status).toBe("auth_expired");
  });
});

describe("reconnect / edit / disconnect", () => {
  it("reconnect starts a fresh OAuth grant and reuses the client registration", async () => {
    await seedUser("u1");
    const { mock, calls } = stubOauthServer();
    vi.stubGlobal("fetch", mock);
    const created = await createMcpServer(env, "u1", ORIGIN, { url: SERVER_URL });

    const result = await reconnectMcpServer(env, "u1", ORIGIN, created.server.id);
    expect(result.requiresAuth).toBe(true);
    expect(result.authorizationUrl).toContain("client_id=client-abc");
    // Registration was not repeated for the same authorization server.
    expect(calls.filter((call) => call.includes("/register"))).toHaveLength(1);
  });

  it("updates the name without touching credentials", async () => {
    await seedUser("u1");
    vi.stubGlobal("fetch", stubOpenServer());
    const created = await createMcpServer(env, "u1", ORIGIN, { url: SERVER_URL });
    const updated = await updateMcpServer(env, "u1", ORIGIN, created.server.id, {
      name: "Renamed",
    });
    expect(updated.server.name).toBe("Renamed");
    expect(updated.requiresAuth).toBe(false);
  });

  it("re-probes when the URL changes and clears stale auth for open servers", async () => {
    await seedUser("u1");
    const { mock } = stubOauthServer();
    vi.stubGlobal("fetch", mock);
    const created = await createMcpServer(env, "u1", ORIGIN, { url: SERVER_URL });
    expect((await getRow(created.server.id)).encryptedAuthData).toBeTruthy();

    vi.stubGlobal("fetch", stubOpenServer());
    const updated = await updateMcpServer(env, "u1", ORIGIN, created.server.id, {
      url: "https://open.example.com/mcp",
    });
    expect(updated.requiresAuth).toBe(false);
    expect(updated.server.status).toBe("connected");
    expect((await getRow(created.server.id)).encryptedAuthData).toBeNull();
  });

  it("deletes only the owner's servers", async () => {
    await seedUser("u1");
    await seedUser("u2");
    vi.stubGlobal("fetch", stubOpenServer());
    const created = await createMcpServer(env, "u1", ORIGIN, { url: SERVER_URL });

    const failure = await deleteMcpServer(env, "u2", created.server.id).catch(
      (error: unknown) => error,
    );
    expect((failure as ApiError).status).toBe(404);

    expect(await deleteMcpServer(env, "u1", created.server.id)).toEqual({ deleted: true });
    expect(await db.query.mcpServer.findMany()).toHaveLength(0);
  });
});

describe("serialization", () => {
  it("never exposes credential material through listMcpServers/toPublicServer", async () => {
    await seedUser("u1");
    const { mock } = stubOauthServer();
    vi.stubGlobal("fetch", mock);
    const created = await createMcpServer(env, "u1", ORIGIN, { url: SERVER_URL });
    const oauthSession = await db.query.mcpOauthSession.findFirst({
      where: eq(mcpOauthSession.serverId, created.server.id),
    });
    await handleOauthCallback(env, "u1", ORIGIN, { state: oauthSession!.state, code: "c" });

    const servers = await listMcpServers(env, "u1");
    expect(servers).toHaveLength(1);
    const serialized = JSON.stringify(servers[0]);
    expect(serialized).not.toContain("access-token-1");
    expect(serialized).not.toContain("refresh-token-1");
    expect(serialized).not.toContain("encryptedAuthData");
    expect(serialized).not.toContain("client-abc");
    expect(toPublicServer(await getRow(created.server.id))).not.toHaveProperty("encryptedAuthData");
  });

  it("only lists the current user's servers", async () => {
    await seedUser("u1");
    await seedUser("u2");
    await seedServers("u2", 2);
    expect(await listMcpServers(env, "u1")).toHaveLength(0);
    expect(await listMcpServers(env, "u2")).toHaveLength(2);
  });
});
