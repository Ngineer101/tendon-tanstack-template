import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "#/db/schema";
import type { DB } from "#/db";
import { ApiError } from "#/lib/api-error";
import { FREE_MCP_SERVER_LIMIT } from "./config";
import {
  beginMcpConnect,
  completeMcpAuthorization,
  createMcpServer,
  deleteMcpServer,
  disconnectMcpServer,
  getMcpAccessToken,
  testMcpServer,
  toPublicMcpServer,
  updateMcpServer,
  type McpDeps,
} from "./core.server";
import { decryptSecret } from "./crypto.server";
import type { AuthorizationServerMetadata } from "./oauth.server";

const KEY = Buffer.alloc(32, 7).toString("base64");
const USER = "user-1";
const OTHER_USER = "user-2";
const ORIGIN = "https://app.example.com";

const AS_METADATA: AuthorizationServerMetadata = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  registration_endpoint: "https://auth.example.com/register",
};

// Run the real generated migrations against an in-memory SQLite database so
// domain logic is exercised on the exact schema that ships to D1.
function createTestDb(): DB {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const migrationsDir = fileURLToPath(new URL("../../../drizzle", import.meta.url));
  for (const file of readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    for (const statement of readFileSync(`${migrationsDir}/${file}`, "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  return drizzle(sqlite, { schema }) as unknown as DB;
}

function makeDeps(overrides: Partial<McpDeps> = {}): McpDeps {
  return {
    probe: vi.fn(async () => ({
      ok: true as const,
      serverInfo: {
        name: "test-server",
        version: "1.0.0",
        capabilities: { tools: true, resources: false, prompts: false },
      },
    })),
    discover: vi.fn(async () => ({
      resource: "https://mcp.example.com/mcp",
      scopes: ["mcp:read"],
      authServer: AS_METADATA,
    })),
    register: vi.fn(async () => ({ clientId: "client-1" })),
    exchangeCode: vi.fn(async () => ({
      access_token: "access-token-1",
      refresh_token: "refresh-token-1",
      expires_in: 3600,
      scope: "mcp:read",
    })),
    refresh: vi.fn(async () => ({ access_token: "refreshed-token", expires_in: 3600 })),
    revoke: vi.fn(async () => {}),
    ...overrides,
  };
}

const unauthorizedProbe = vi.fn(async () => ({
  ok: false as const,
  reason: "unauthorized" as const,
  wwwAuthenticate:
    'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
}));

let db: DB;

beforeEach(async () => {
  db = createTestDb();
  for (const id of [USER, OTHER_USER]) {
    await db.insert(schema.user).values({ id, name: id, email: `${id}@example.com` });
  }
});

async function addServer(url = "https://mcp.example.com/mcp", userId = USER) {
  return createMcpServer(db, { userId, name: "Test server", url, unlimited: false });
}

describe("createMcpServer", () => {
  it("creates a server pending authorization", async () => {
    const server = await addServer();
    expect(server.status).toBe("pending_auth");
    expect(server.url).toBe("https://mcp.example.com/mcp");
  });

  it("validates the name", async () => {
    await expect(
      createMcpServer(db, {
        userId: USER,
        name: "  ",
        url: "https://a.example.com",
        unlimited: false,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createMcpServer(db, {
        userId: USER,
        name: "x".repeat(61),
        url: "https://a.example.com",
        unlimited: false,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects unsafe URLs", async () => {
    for (const url of ["http://mcp.example.com", "https://192.168.0.1/mcp", "notaurl"]) {
      await expect(
        createMcpServer(db, { userId: USER, name: "Bad", url, unlimited: false }),
      ).rejects.toMatchObject({ status: 400 });
    }
  });

  it("rejects duplicate URLs per user", async () => {
    await addServer();
    await expect(addServer()).rejects.toMatchObject({ status: 409 });
    // A different user can still add the same URL.
    await expect(addServer("https://mcp.example.com/mcp", OTHER_USER)).resolves.toBeDefined();
  });

  it(`enforces the ${FREE_MCP_SERVER_LIMIT}-server limit for free users`, async () => {
    for (let index = 0; index < FREE_MCP_SERVER_LIMIT; index += 1) {
      await addServer(`https://mcp-${index}.example.com/mcp`);
    }
    await expect(addServer("https://one-too-many.example.com/mcp")).rejects.toMatchObject({
      status: 402,
      details: { code: "mcp_server_limit" },
    });
  });

  it("does not limit entitled (pro) users", async () => {
    for (let index = 0; index < FREE_MCP_SERVER_LIMIT + 2; index += 1) {
      await expect(
        createMcpServer(db, {
          userId: USER,
          name: `Server ${index}`,
          url: `https://mcp-${index}.example.com/mcp`,
          unlimited: true,
        }),
      ).resolves.toBeDefined();
    }
  });

  it("counts limits per user, not globally", async () => {
    for (let index = 0; index < FREE_MCP_SERVER_LIMIT; index += 1) {
      await addServer(`https://mcp-${index}.example.com/mcp`, OTHER_USER);
    }
    await expect(addServer()).resolves.toBeDefined();
  });
});

describe("authorization boundaries", () => {
  it("hides other users' servers from every action", async () => {
    const server = await addServer();
    const asOther = { userId: OTHER_USER, serverId: server.id };
    await expect(testMcpServer(db, KEY, asOther, makeDeps())).rejects.toMatchObject({
      status: 404,
    });
    await expect(deleteMcpServer(db, KEY, asOther, makeDeps())).rejects.toMatchObject({
      status: 404,
    });
    await expect(disconnectMcpServer(db, KEY, asOther, makeDeps())).rejects.toMatchObject({
      status: 404,
    });
    await expect(updateMcpServer(db, { ...asOther, name: "Hijacked" })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      beginMcpConnect(db, KEY, { ...asOther, origin: ORIGIN }, makeDeps()),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("beginMcpConnect", () => {
  it("connects immediately when the server needs no auth", async () => {
    const server = await addServer();
    const result = await beginMcpConnect(
      db,
      KEY,
      { userId: USER, serverId: server.id, origin: ORIGIN },
      makeDeps(),
    );
    expect(result.kind).toBe("connected");
    if (result.kind === "connected") {
      expect(result.server.status).toBe("connected");
      expect(result.server.authType).toBe("none");
      expect(JSON.parse(result.server.serverInfo!)).toMatchObject({ name: "test-server" });
    }
  });

  it("prepares an OAuth redirect when the server requires auth", async () => {
    const server = await addServer();
    const deps = makeDeps({ probe: unauthorizedProbe });
    const result = await beginMcpConnect(
      db,
      KEY,
      { userId: USER, serverId: server.id, origin: ORIGIN },
      deps,
    );
    expect(result.kind).toBe("authorize");
    if (result.kind !== "authorize") return;

    const url = new URL(result.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/mcp/oauth/callback`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("mcp:read");

    const state = url.searchParams.get("state")!;
    const session = await db.query.mcpOauthSession.findFirst({
      where: eq(schema.mcpOauthSession.state, state),
    });
    expect(session?.serverId).toBe(server.id);
    // The PKCE verifier is stored encrypted, never in the clear.
    expect(session?.codeVerifierEnc).toMatch(/^v1\./);

    const stored = await db.query.mcpServer.findFirst({
      where: eq(schema.mcpServer.id, server.id),
    });
    expect(stored?.authType).toBe("oauth");
    expect(stored?.clientId).toBe("client-1");
  });

  it("marks the server errored when it is unreachable", async () => {
    const server = await addServer();
    const deps = makeDeps({
      probe: vi.fn(async () => ({
        ok: false as const,
        reason: "error" as const,
        message: "The server responded with status 500",
      })),
    });
    await expect(
      beginMcpConnect(db, KEY, { userId: USER, serverId: server.id, origin: ORIGIN }, deps),
    ).rejects.toMatchObject({ status: 502 });
    const stored = await db.query.mcpServer.findFirst({
      where: eq(schema.mcpServer.id, server.id),
    });
    expect(stored?.status).toBe("error");
    expect(stored?.lastError).toContain("500");
  });
});

async function startOAuthFlow(deps = makeDeps({ probe: unauthorizedProbe })) {
  const server = await addServer();
  const result = await beginMcpConnect(
    db,
    KEY,
    { userId: USER, serverId: server.id, origin: ORIGIN },
    deps,
  );
  if (result.kind !== "authorize") throw new Error("expected authorize");
  const state = new URL(result.authorizeUrl).searchParams.get("state")!;
  return { server, state };
}

describe("completeMcpAuthorization", () => {
  it("exchanges the code, encrypts tokens at rest, and marks the server connected", async () => {
    const { server, state } = await startOAuthFlow();
    const connected = await completeMcpAuthorization(
      db,
      KEY,
      { userId: USER, state, code: "auth-code" },
      makeDeps(),
    );
    expect(connected.status).toBe("connected");
    expect(connected.scope).toBe("mcp:read");
    // Tokens are never stored in plaintext.
    expect(connected.accessTokenEnc).not.toContain("access-token-1");
    await expect(decryptSecret(KEY, connected.accessTokenEnc!)).resolves.toBe("access-token-1");
    await expect(decryptSecret(KEY, connected.refreshTokenEnc!)).resolves.toBe("refresh-token-1");
    // Public serialization exposes no auth material.
    const publicServer = toPublicMcpServer(connected);
    expect(JSON.stringify(publicServer)).not.toContain("token");
    expect(server.id).toBe(connected.id);
  });

  it("rejects an unknown state", async () => {
    await expect(
      completeMcpAuthorization(db, KEY, { userId: USER, state: "bogus", code: "c" }, makeDeps()),
    ).rejects.toMatchObject({ status: 400, details: { code: "oauth_state_invalid" } });
  });

  it("rejects a state that belongs to another user", async () => {
    const { state } = await startOAuthFlow();
    await expect(
      completeMcpAuthorization(db, KEY, { userId: OTHER_USER, state, code: "c" }, makeDeps()),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("consumes the state — a second use fails", async () => {
    const { state } = await startOAuthFlow();
    await completeMcpAuthorization(db, KEY, { userId: USER, state, code: "c" }, makeDeps());
    await expect(
      completeMcpAuthorization(db, KEY, { userId: USER, state, code: "c" }, makeDeps()),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an expired state", async () => {
    const { state } = await startOAuthFlow();
    await db
      .update(schema.mcpOauthSession)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.mcpOauthSession.state, state));
    await expect(
      completeMcpAuthorization(db, KEY, { userId: USER, state, code: "c" }, makeDeps()),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("testMcpServer", () => {
  it("marks a healthy server connected", async () => {
    const server = await addServer();
    const { server: tested, healthy } = await testMcpServer(
      db,
      KEY,
      { userId: USER, serverId: server.id },
      makeDeps(),
    );
    expect(healthy).toBe(true);
    expect(tested.status).toBe("connected");
    expect(tested.lastTestedAt).toBeInstanceOf(Date);
  });

  it("flags needs_auth when the server rejects credentials", async () => {
    const server = await addServer();
    const { server: tested, healthy } = await testMcpServer(
      db,
      KEY,
      { userId: USER, serverId: server.id },
      makeDeps({ probe: unauthorizedProbe }),
    );
    expect(healthy).toBe(false);
    expect(tested.status).toBe("needs_auth");
    expect(tested.lastError).toContain("reconnect");
  });

  it("refreshes an expiring token before testing", async () => {
    const { state } = await startOAuthFlow();
    const connected = await completeMcpAuthorization(
      db,
      KEY,
      { userId: USER, state, code: "c" },
      makeDeps(),
    );
    await db
      .update(schema.mcpServer)
      .set({ accessTokenExpiresAt: new Date(Date.now() + 1000) })
      .where(eq(schema.mcpServer.id, connected.id));

    const deps = makeDeps();
    const probeSpy = deps.probe as ReturnType<typeof vi.fn>;
    const { healthy, server: tested } = await testMcpServer(
      db,
      KEY,
      { userId: USER, serverId: connected.id },
      deps,
    );
    expect(healthy).toBe(true);
    expect(deps.refresh).toHaveBeenCalledOnce();
    expect(probeSpy).toHaveBeenCalledWith(connected.url, "refreshed-token");
    await expect(decryptSecret(KEY, tested.accessTokenEnc!)).resolves.toBe("refreshed-token");
  });

  it("requires reconnect when the refresh fails", async () => {
    const { state } = await startOAuthFlow();
    const connected = await completeMcpAuthorization(
      db,
      KEY,
      { userId: USER, state, code: "c" },
      makeDeps(),
    );
    await db
      .update(schema.mcpServer)
      .set({ accessTokenExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.mcpServer.id, connected.id));

    const deps = makeDeps({
      refresh: vi.fn(async () => {
        throw new ApiError(502, "refresh rejected");
      }),
    });
    const { healthy, server: tested } = await testMcpServer(
      db,
      KEY,
      { userId: USER, serverId: connected.id },
      deps,
    );
    expect(healthy).toBe(false);
    expect(tested.status).toBe("needs_auth");
  });
});

describe("updateMcpServer", () => {
  it("renames without touching auth state", async () => {
    const { state } = await startOAuthFlow();
    const connected = await completeMcpAuthorization(
      db,
      KEY,
      { userId: USER, state, code: "c" },
      makeDeps(),
    );
    const updated = await updateMcpServer(db, {
      userId: USER,
      serverId: connected.id,
      name: "Renamed",
    });
    expect(updated.name).toBe("Renamed");
    expect(updated.status).toBe("connected");
    expect(updated.accessTokenEnc).toBe(connected.accessTokenEnc);
  });

  it("resets auth state when the URL changes", async () => {
    const { state } = await startOAuthFlow();
    const connected = await completeMcpAuthorization(
      db,
      KEY,
      { userId: USER, state, code: "c" },
      makeDeps(),
    );
    const updated = await updateMcpServer(db, {
      userId: USER,
      serverId: connected.id,
      url: "https://different.example.com/mcp",
    });
    expect(updated.status).toBe("pending_auth");
    expect(updated.authType).toBeNull();
    expect(updated.accessTokenEnc).toBeNull();
    expect(updated.clientId).toBeNull();
    expect(updated.serverInfo).toBeNull();
  });
});

describe("disconnect and delete", () => {
  it("disconnect revokes and clears tokens but keeps the server", async () => {
    const { state } = await startOAuthFlow();
    const connected = await completeMcpAuthorization(
      db,
      KEY,
      { userId: USER, state, code: "c" },
      makeDeps(),
    );
    const deps = makeDeps();
    const disconnected = await disconnectMcpServer(
      db,
      KEY,
      { userId: USER, serverId: connected.id },
      deps,
    );
    expect(disconnected.status).toBe("disconnected");
    expect(disconnected.accessTokenEnc).toBeNull();
    expect(disconnected.refreshTokenEnc).toBeNull();
    expect(deps.revoke).toHaveBeenCalledOnce();
    // Client registration is kept for a fast reconnect.
    expect(disconnected.clientId).toBe("client-1");
  });

  it("delete removes the server and its pending sessions", async () => {
    const { server, state } = await startOAuthFlow();
    await deleteMcpServer(db, KEY, { userId: USER, serverId: server.id }, makeDeps());
    expect(
      await db.query.mcpServer.findFirst({ where: eq(schema.mcpServer.id, server.id) }),
    ).toBeUndefined();
    expect(
      await db.query.mcpOauthSession.findFirst({
        where: eq(schema.mcpOauthSession.state, state),
      }),
    ).toBeUndefined();
  });
});

describe("getMcpAccessToken", () => {
  it("returns null for servers without auth", async () => {
    const server = await addServer();
    await beginMcpConnect(
      db,
      KEY,
      { userId: USER, serverId: server.id, origin: ORIGIN },
      makeDeps(),
    );
    await expect(
      getMcpAccessToken(db, KEY, { userId: USER, serverId: server.id }, makeDeps()),
    ).resolves.toBeNull();
  });

  it("returns a decrypted token for connected OAuth servers", async () => {
    const { state, server } = await startOAuthFlow();
    await completeMcpAuthorization(db, KEY, { userId: USER, state, code: "c" }, makeDeps());
    await expect(
      getMcpAccessToken(db, KEY, { userId: USER, serverId: server.id }, makeDeps()),
    ).resolves.toBe("access-token-1");
  });
});
