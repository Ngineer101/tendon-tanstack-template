import { beforeEach, describe, expect, it, vi } from "vitest";

import { eq } from "drizzle-orm";

import { getDb } from "#/db";
import { mcpServer } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import { getEncryptionKey, type McpEnv } from "#/lib/mcp/config.server";
import {
  assertWithinMcpLimit,
  completeAuthorization,
  createMcpServerConnection,
  deleteMcpServer,
  disconnectMcpServer,
  discoverOauthMetadata,
  editMcpServer,
  getMcpLimit,
  getMcpServerForUser,
  listMcpServers,
  testMcpServer,
} from "#/lib/mcp/core.server";
import { cipher } from "#/lib/mcp/crypto.server";
import { validateOutboundUrl } from "#/lib/mcp/url.server";
import { createTestD1, createTestEnv } from "./test-d1";

// Mock the billing entitlement so the three-server limit can be tested without
// the Stripe/D1 billing pipeline. `hasEntitlement` is the only billing surface
// the MCP core touches.
vi.mock("#/lib/billing/core.server", () => ({
  hasEntitlement: vi.fn(),
}));

import { hasEntitlement } from "#/lib/billing/core.server";

const validUrl = "https://example.com/mcp";
const normalized = validateOutboundUrl(validUrl);

function seedServer(
  db: ReturnType<typeof getDb>,
  overrides: Partial<typeof mcpServer.$inferInsert> & { id?: string },
) {
  return db
    .insert(mcpServer)
    .values({
      id: overrides.id ?? `mcp_${crypto.randomUUID()}`,
      userId: overrides.userId ?? "user-a",
      name: overrides.name ?? "Test server",
      url: overrides.url ?? validUrl,
      status: overrides.status ?? "connected",
      metadata: overrides.metadata ?? null,
      encryptedAuth: overrides.encryptedAuth ?? null,
      oauthPending: overrides.oauthPending ?? null,
      lastError: overrides.lastError ?? null,
    })
    .returning();
}

function makeFetchReturningJson(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

function jsonOkResponse(body: unknown) {
  return Response.json(body, { status: 200 });
}

let d1: D1Database;
let env: McpEnv;
let userId: string;

beforeEach(() => {
  d1 = createTestD1();
  env = createTestEnv(d1);
  userId = `user-${Math.random().toString(36).slice(2)}`;
  vi.mocked(hasEntitlement).mockReset();
});

describe("getMcpLimit / assertWithinMcpLimit", () => {
  it("returns Infinity for pro users and bypasses the limit", async () => {
    vi.mocked(hasEntitlement).mockResolvedValue(true);
    const limit = await getMcpLimit(env, userId);
    expect(Number.isFinite(limit.limit)).toBe(false);
    expect(limit.pro).toBe(true);

    const db = getDb(env.DB);
    for (let i = 0; i < 5; i += 1) {
      await seedServer(db, { userId, url: `https://example.com/mcp-${i}` });
    }
    await expect(assertWithinMcpLimit(env, userId)).resolves.toBeUndefined();
  });

  it("allows a free user under the 3-server limit", async () => {
    vi.mocked(hasEntitlement).mockResolvedValue(false);
    const db = getDb(env.DB);
    await seedServer(db, { userId, url: "https://example.com/mcp-1" });
    await seedServer(db, { userId, url: "https://example.com/mcp-2" });
    await expect(assertWithinMcpLimit(env, userId)).resolves.toBeUndefined();
  });

  it("rejects a free user at the 3-server limit with a 402", async () => {
    vi.mocked(hasEntitlement).mockResolvedValue(false);
    const db = getDb(env.DB);
    await seedServer(db, { userId, url: "https://example.com/mcp-1" });
    await seedServer(db, { userId, url: "https://example.com/mcp-2" });
    await seedServer(db, { userId, url: "https://example.com/mcp-3" });
    const error = await assertWithinMcpLimit(env, userId).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(402);
    expect((error as ApiError).message).toContain("3 MCP servers");
  });
});

describe("listMcpServers", () => {
  it("returns safe rows sorted by creation time and never exposes secrets", async () => {
    const db = getDb(env.DB);
    const encrypted = await cipher.encrypt({ accessToken: "tok" }, getEncryptionKey(env));
    await seedServer(db, { userId, id: "mcp_a", url: "https://a.example/mcp", name: "A" });
    await seedServer(db, {
      userId,
      id: "mcp_b",
      url: "https://b.example/mcp",
      name: "B",
      encryptedAuth: encrypted,
    });

    const servers = await listMcpServers(env, userId);
    expect(servers).toHaveLength(2);
    expect(servers.every((s) => !("encryptedAuth" in s))).toBe(true);
    expect(servers.every((s) => !("oauthPending" in s))).toBe(true);
    expect(servers.map((s) => [s.id, s.name])).toEqual([
      ["mcp_a", "A"],
      ["mcp_b", "B"],
    ]);
  });

  it("does not leak another user's servers", async () => {
    const db = getDb(env.DB);
    await seedServer(db, { userId, name: "mine", url: "https://a.example/mcp" });
    await seedServer(db, { userId: "intruder", name: "theirs", url: "https://b.example/mcp" });
    const servers = await listMcpServers(env, "intruder");
    expect(servers.map((s) => s.name)).toEqual(["theirs"]);
  });
});

describe("getMcpServerForUser (authorization)", () => {
  it("throws 404 when the server belongs to another user", async () => {
    const db = getDb(env.DB);
    const [row] = await seedServer(db, { userId, id: "mcp_owner", url: "https://a.example/mcp" });
    await expect(getMcpServerForUser(env, "intruder", row.id)).rejects.toBeInstanceOf(ApiError);
  });
});

describe("createMcpServerConnection", () => {
  it("rejects a missing/invalid name", async () => {
    await expect(
      createMcpServerConnection(env, userId, { name: "", url: validUrl }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      createMcpServerConnection(env, userId, { name: "x".repeat(81), url: validUrl }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("creates a pending server when OAuth metadata is not published", async () => {
    vi.mocked(hasEntitlement).mockResolvedValue(false);
    const fetchMock = makeFetchReturningJson(404, { error: "not found" });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { server, requiresAuth } = await createMcpServerConnection(env, userId, {
        name: "My server",
        url: validUrl,
      });
      expect(requiresAuth).toBe(false);
      expect(server.status).toBe("pending");
      expect(server.url).toBe("https://example.com/mcp");
      expect(server.name).toBe("My server");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects when the server is unreachable (502 from discovery)", async () => {
    vi.mocked(hasEntitlement).mockResolvedValue(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    try {
      await expect(
        createMcpServerConnection(env, userId, { name: "Dead", url: "https://dead.example/mcp" }),
      ).rejects.toBeInstanceOf(ApiError);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("enforces the free 3-server limit on creation", async () => {
    vi.mocked(hasEntitlement).mockResolvedValue(false);
    const fetchMock = makeFetchReturningJson(404, {});
    vi.stubGlobal("fetch", fetchMock);
    try {
      const db = getDb(env.DB);
      await seedServer(db, { userId, url: "https://example.com/s1" });
      await seedServer(db, { userId, url: "https://example.com/s2" });
      await seedServer(db, { userId, url: "https://example.com/s3" });
      await expect(
        createMcpServerConnection(env, userId, { name: "Fourth", url: "https://example.com/s4" }),
      ).rejects.toMatchObject({ status: 402 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("discoverOauthMetadata", () => {
  it("parses a well-formed metadata document", async () => {
    const fetchMock = vi.fn(async () =>
      jsonOkResponse({
        authorization_endpoint: "https://example.com/oauth/authorize",
        token_endpoint: "https://example.com/oauth/token",
        scopes_supported: ["read", "write"],
        grant_types_supported: ["authorization_code"],
        response_types_supported: ["code"],
      }),
    );
    const metadata = await discoverOauthMetadata(normalized, fetchMock as unknown as typeof fetch);
    expect(metadata.authorizationEndpoint).toBe("https://example.com/oauth/authorize");
    expect(metadata.tokenEndpoint).toBe("https://example.com/oauth/token");
    expect(metadata.scopesSupported).toEqual(["read", "write"]);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("throws 422 when the server returns 404 (no metadata)", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 404 }));
    const error = await discoverOauthMetadata(
      normalized,
      fetchMock as unknown as typeof fetch,
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
  });

  it("throws 502 when the server is unreachable or errors", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    const error = await discoverOauthMetadata(
      normalized,
      fetchMock as unknown as typeof fetch,
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });
});

describe("completeAuthorization", () => {
  async function seedPendingRow(overrides: {
    state: string;
    codeVerifier: string;
    createdAt?: number;
  }) {
    const db = getDb(env.DB);
    const key = getEncryptionKey(env);
    const metadata = JSON.stringify({
      authorizationEndpoint: "https://example.com/oauth/authorize",
      tokenEndpoint: "https://example.com/oauth/token",
      grantTypesSupported: ["authorization_code"],
    });
    const pending = {
      codeVerifier: overrides.codeVerifier,
      state: overrides.state,
      redirectUri: "https://example.com/api/mcp/oauth/callback",
      createdAt: overrides.createdAt ?? Date.now(),
    };
    const oauthPending = await cipher.encrypt(pending, key);
    await seedServer(db, {
      userId,
      id: "mcp_auth",
      url: validUrl,
      status: "pending",
      metadata,
      oauthPending,
    });
  }

  it("exchanges the code and marks the server connected with encrypted auth", async () => {
    await seedPendingRow({ state: "mcp_auth:state123", codeVerifier: "verifier123" });
    const fetchMock = vi.fn(async () =>
      jsonOkResponse({
        access_token: "access-tok",
        refresh_token: "refresh-tok",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read",
      }),
    );
    const server = await completeAuthorization(
      env,
      { code: "code123", state: "mcp_auth:state123" },
      fetchMock as unknown as typeof fetch,
    );
    expect(server.status).toBe("connected");

    const db = getDb(env.DB);
    const row = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, "mcp_auth") });
    expect(row?.encryptedAuth).toBeTruthy();
    expect(row?.oauthPending).toBeNull();
    const decrypted = await cipher.decrypt<{ accessToken: string }>(
      row!.encryptedAuth!,
      getEncryptionKey(env),
    );
    expect(decrypted.accessToken).toBe("access-tok");

    // Tokens must never be echoed back to the client via the safe projection.
    expect(JSON.stringify(server)).not.toContain("access-tok");
  });

  it("rejects a state that does not match the stored value", async () => {
    await seedPendingRow({ state: "mcp_auth:real-state", codeVerifier: "v" });
    const fetchMock = vi.fn(async () => jsonOkResponse({ access_token: "x" }));
    await expect(
      completeAuthorization(
        env,
        { code: "c", state: "mcp_auth:wrong-state" },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects an expired authorization flow", async () => {
    await seedPendingRow({
      state: "mcp_auth:expired",
      codeVerifier: "v",
      createdAt: Date.now() - 11 * 60 * 1000,
    });
    const fetchMock = vi.fn(async () => jsonOkResponse({ access_token: "x" }));
    await expect(
      completeAuthorization(
        env,
        { code: "c", state: "mcp_auth:expired" },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/expired/i) });
  });

  it("surfaces the upstream error parameter as a 400", async () => {
    await expect(
      completeAuthorization(env, {
        code: "",
        state: "",
        error: "access_denied",
        errorDescription: "user said no",
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("user said no") });
  });

  it("rejects a token endpoint that returns an error status", async () => {
    await seedPendingRow({ state: "mcp_auth:ok", codeVerifier: "v" });
    const fetchMock = vi.fn(async () => new Response("error", { status: 400 }));
    await expect(
      completeAuthorization(
        env,
        { code: "c", state: "mcp_auth:ok" },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("testMcpServer", () => {
  it("returns ok and stores serverInfo when initialize succeeds", async () => {
    const db = getDb(env.DB);
    const encrypted = await cipher.encrypt({ accessToken: "tok" }, getEncryptionKey(env));
    await seedServer(db, { userId, id: "mcp_test", url: validUrl, encryptedAuth: encrypted });
    const fetchMock = vi.fn(async () =>
      jsonOkResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "MyMcp", version: "1.2.3" },
          capabilities: { tools: {} },
        },
      }),
    );
    const result = await testMcpServer(
      env,
      userId,
      "mcp_test",
      fetchMock as unknown as typeof fetch,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.serverInfo.name).toBe("MyMcp");
      expect(result.serverInfo.version).toBe("1.2.3");
    }
    const row = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, "mcp_test") });
    expect(row?.status).toBe("connected");
    expect(row?.lastTestedAt).toBeTruthy();
  });

  it("returns an error when the server responds with a non-OK status", async () => {
    const db = getDb(env.DB);
    await seedServer(db, { userId, id: "mcp_bad", url: validUrl });
    const fetchMock = vi.fn(async () => new Response("", { status: 500 }));
    const result = await testMcpServer(
      env,
      userId,
      "mcp_bad",
      fetchMock as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/HTTP 500/);
  });

  it("returns an error when stored credentials cannot be decrypted", async () => {
    const db = getDb(env.DB);
    await seedServer(db, {
      userId,
      id: "mcp_corrupt",
      url: validUrl,
      encryptedAuth: "this-is-not-valid-ciphertext",
    });
    const fetchMock = vi.fn(async () => jsonOkResponse({ result: { serverInfo: {} } }));
    const result = await testMcpServer(
      env,
      userId,
      "mcp_corrupt",
      fetchMock as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a test for another user's server", async () => {
    const db = getDb(env.DB);
    await seedServer(db, { userId, id: "mcp_owner", url: validUrl });
    await expect(testMcpServer(env, "intruder", "mcp_owner", vi.fn())).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

describe("editMcpServer", () => {
  it("renames the server without touching auth", async () => {
    const db = getDb(env.DB);
    const encrypted = await cipher.encrypt({ accessToken: "tok" }, getEncryptionKey(env));
    await seedServer(db, { userId, id: "mcp_edit", url: validUrl, encryptedAuth: encrypted });
    const server = await editMcpServer(env, userId, "mcp_edit", { name: "New name" });
    expect(server.name).toBe("New name");
    const row = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, "mcp_edit") });
    expect(row?.encryptedAuth).toBe(encrypted);
  });

  it("invalidates auth and re-runs discovery when the URL changes", async () => {
    const db = getDb(env.DB);
    const encrypted = await cipher.encrypt({ accessToken: "tok" }, getEncryptionKey(env));
    await seedServer(db, { userId, id: "mcp_url", url: validUrl, encryptedAuth: encrypted });
    vi.stubGlobal("fetch", makeFetchReturningJson(404, {}));
    try {
      const server = await editMcpServer(env, userId, "mcp_url", {
        url: "https://new.example/mcp",
      });
      expect(server.url).toBe("https://new.example/mcp");
      expect(server.status).toBe("pending");
    } finally {
      vi.unstubAllGlobals();
    }
    const row = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, "mcp_url") });
    expect(row?.encryptedAuth).toBeNull();
  });
});

describe("disconnectMcpServer", () => {
  it("clears credentials and pending state but keeps the row as disconnected", async () => {
    const db = getDb(env.DB);
    const encrypted = await cipher.encrypt({ accessToken: "tok" }, getEncryptionKey(env));
    await seedServer(db, {
      userId,
      id: "mcp_disc",
      url: validUrl,
      encryptedAuth: encrypted,
      oauthPending: "pending-blob",
    });
    const server = await disconnectMcpServer(env, userId, "mcp_disc");
    expect(server.status).toBe("disconnected");
    const row = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, "mcp_disc") });
    expect(row?.encryptedAuth).toBeNull();
    expect(row?.oauthPending).toBeNull();
    expect(row).toBeTruthy();
  });

  it("rejects disconnecting another user's server", async () => {
    const db = getDb(env.DB);
    await seedServer(db, { userId, id: "mcp_owner", url: validUrl });
    await expect(disconnectMcpServer(env, "intruder", "mcp_owner")).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

describe("deleteMcpServer", () => {
  it("removes the row", async () => {
    const db = getDb(env.DB);
    await seedServer(db, { userId, id: "mcp_del", url: validUrl });
    await deleteMcpServer(env, userId, "mcp_del");
    const row = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, "mcp_del") });
    expect(row).toBeUndefined(); // drizzle returns undefined for missing rows via fake findFirst? handled below
  });

  it("throws 404 if the row does not exist or belongs to another user", async () => {
    const db = getDb(env.DB);
    await seedServer(db, { userId, id: "mcp_del2", url: validUrl });
    await expect(deleteMcpServer(env, "intruder", "mcp_del2")).rejects.toMatchObject({
      status: 404,
    });
  });
});
