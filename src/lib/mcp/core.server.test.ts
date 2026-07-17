import { beforeEach, describe, expect, it } from "vitest";

import type { McpApiEnv } from "./config.server";
import {
  completeOAuth,
  createServer,
  deleteServer,
  getConnectedServersWithAuth,
  listMcpServers,
  testServer,
  updateServer,
} from "./core.server";
import { encryptJson } from "./crypto.server";
import { createMockD1, seedProSubscription, seedUser, type MockD1 } from "./testing/mock-d1";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const ORIGIN = "https://app.example.com";

let d1: MockD1;
let env: McpApiEnv;

function noAuthFetch(): FetchLike {
  return async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: "tendon-probe", result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

function seedServerRow(
  overrides: Partial<{
    id: string;
    userId: string;
    name: string;
    url: string;
    status: string;
    authType: string;
    encryptedAuth: string | null;
  }> = {},
) {
  const row = {
    id: overrides.id ?? `mcp_${crypto.randomUUID()}`,
    userId: overrides.userId ?? "user1",
    name: overrides.name ?? "Test server",
    url: overrides.url ?? "https://mcp.example.com/mcp",
    status: overrides.status ?? "connected",
    authType: overrides.authType ?? "none",
    encryptedAuth: overrides.encryptedAuth ?? null,
  };
  d1.sqlite
    .prepare(
      "INSERT INTO mcp_server (id, user_id, name, url, status, auth_type, encrypted_auth) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(row.id, row.userId, row.name, row.url, row.status, row.authType, row.encryptedAuth);
  return row;
}

beforeEach(() => {
  d1 = createMockD1();
  env = {
    DB: d1,
    MCP_ENCRYPTION_KEY: "test-encryption-key-with-plenty-of-entropy",
  } as unknown as McpApiEnv;
  seedUser(d1, "user1");
  seedUser(d1, "user2");
});

describe("createServer", () => {
  it("connects immediately when the server requires no auth", async () => {
    const result = await createServer(
      env,
      "user1",
      { name: "Public server", url: "https://mcp.example.com/mcp" },
      ORIGIN,
      noAuthFetch(),
    );

    expect(result.authorizationUrl).toBeNull();
    expect(result.server.status).toBe("connected");
    expect(result.server.authType).toBe("none");
    expect(result.server.lastTestedAt).not.toBeNull();
  });

  it("keeps the row in an error state when the server is unreachable", async () => {
    const failingFetch: FetchLike = () => Promise.reject(new Error("connect ECONNREFUSED"));

    const result = await createServer(
      env,
      "user1",
      { name: "Down server", url: "https://down.example.com/mcp" },
      ORIGIN,
      failingFetch,
    );

    expect(result.server.status).toBe("error");
    expect(result.server.lastError).toBe(
      "Unable to reach the MCP server. Check the URL and try again.",
    );
    expect(result.server.lastError).not.toContain("ECONNREFUSED");
  });

  it("enforces the three-server limit for free users", async () => {
    for (let index = 0; index < 3; index++) {
      await createServer(
        env,
        "user1",
        { name: `Server ${index}`, url: `https://mcp${index}.example.com/mcp` },
        ORIGIN,
        noAuthFetch(),
      );
    }

    const error = await createServer(
      env,
      "user1",
      { name: "One too many", url: "https://mcp4.example.com/mcp" },
      ORIGIN,
      noAuthFetch(),
    ).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      status: 403,
      details: { code: "limit_reached", limit: 3 },
    });
    expect((error as Error).message).toContain("3 MCP servers");

    const { servers, usage } = await listMcpServers(env, "user1");
    expect(servers).toHaveLength(3);
    expect(usage).toEqual({ count: 3, limit: 3 });
  });

  it("enforces the limit atomically when rows already exist", async () => {
    // Seed rows directly to bypass the happy path and exercise the guarded insert.
    for (let index = 0; index < 3; index++) {
      seedServerRow({ url: `https://seeded${index}.example.com/mcp` });
    }

    await expect(
      createServer(
        env,
        "user1",
        { name: "Extra", url: "https://extra.example.com/mcp" },
        ORIGIN,
        noAuthFetch(),
      ),
    ).rejects.toMatchObject({ status: 403, details: { code: "limit_reached" } });
  });

  it("allows unlimited servers for pro users", async () => {
    seedProSubscription(d1, "user1");

    for (let index = 0; index < 4; index++) {
      await createServer(
        env,
        "user1",
        { name: `Server ${index}`, url: `https://mcp${index}.example.com/mcp` },
        ORIGIN,
        noAuthFetch(),
      );
    }

    const { servers, usage } = await listMcpServers(env, "user1");
    expect(servers).toHaveLength(4);
    expect(usage.limit).toBeNull();
  });

  it("rejects duplicate URLs per user with 409", async () => {
    await createServer(
      env,
      "user1",
      { name: "One", url: "https://mcp.example.com/mcp" },
      ORIGIN,
      noAuthFetch(),
    );

    await expect(
      createServer(
        env,
        "user1",
        { name: "Two", url: "https://mcp.example.com/mcp" },
        ORIGIN,
        noAuthFetch(),
      ),
    ).rejects.toMatchObject({ status: 409 });

    // A different user may connect the same URL.
    await expect(
      createServer(
        env,
        "user2",
        { name: "Two", url: "https://mcp.example.com/mcp" },
        ORIGIN,
        noAuthFetch(),
      ),
    ).resolves.toMatchObject({ server: { status: "connected" } });
  });

  it("rejects SSRF URLs before inserting anything", async () => {
    await expect(
      createServer(
        env,
        "user1",
        { name: "Bad", url: "https://169.254.169.254/mcp" },
        ORIGIN,
        noAuthFetch(),
      ),
    ).rejects.toMatchObject({ status: 400 });

    const { servers } = await listMcpServers(env, "user1");
    expect(servers).toHaveLength(0);
  });

  it("validates the name", async () => {
    await expect(
      createServer(
        env,
        "user1",
        { name: "   ", url: "https://mcp.example.com/mcp" },
        ORIGIN,
        noAuthFetch(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createServer(
        env,
        "user1",
        { name: "x".repeat(81), url: "https://mcp.example.com/mcp" },
        ORIGIN,
        noAuthFetch(),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("listMcpServers", () => {
  it("never serializes secret material to DTOs", async () => {
    const tokens = { accessToken: "at-secret", refreshToken: "rt-secret", tokenType: "Bearer" };
    seedServerRow({
      authType: "oauth",
      encryptedAuth: await encryptJson(env, tokens),
    });
    d1.sqlite
      .prepare("UPDATE mcp_server SET oauth_client_id = ?, oauth_client_secret = ?")
      .run("client-id", await encryptJson(env, "client-secret"));

    const { servers } = await listMcpServers(env, "user1");
    const serialized = JSON.stringify(servers[0]);

    expect(serialized).not.toContain("at-secret");
    expect(serialized).not.toContain("rt-secret");
    expect(serialized).not.toContain("client-secret");
    expect(serialized).not.toContain("encryptedAuth");
    expect(serialized).not.toContain("oauthClientSecret");
  });

  it("only returns the requesting user's servers", async () => {
    seedServerRow({ userId: "user1", url: "https://a.example.com/mcp" });
    seedServerRow({ userId: "user2", url: "https://b.example.com/mcp" });

    const { servers } = await listMcpServers(env, "user1");
    expect(servers).toHaveLength(1);
    expect(servers[0].url).toBe("https://a.example.com/mcp");
  });
});

describe("updateServer", () => {
  it("renames a server", async () => {
    const row = seedServerRow();
    const updated = await updateServer(env, "user1", row.id, { name: "Renamed" });
    expect(updated.name).toBe("Renamed");
    expect(updated.status).toBe("connected");
  });

  it("resets credentials when the URL changes", async () => {
    const tokens = { accessToken: "at-secret", tokenType: "Bearer" };
    const row = seedServerRow({
      authType: "oauth",
      encryptedAuth: await encryptJson(env, tokens),
    });

    const updated = await updateServer(env, "user1", row.id, {
      url: "https://new.example.com/mcp",
    });

    expect(updated.url).toBe("https://new.example.com/mcp");
    expect(updated.status).toBe("pending_auth");
    expect(updated.authType).toBe("unknown");

    const stored = d1.sqlite
      .prepare("SELECT encrypted_auth, oauth_client_id FROM mcp_server WHERE id = ?")
      .get(row.id) as { encrypted_auth: string | null; oauth_client_id: string | null };
    expect(stored.encrypted_auth).toBeNull();

    const chatView = await getConnectedServersWithAuth(env, "user1");
    expect(chatView).toHaveLength(0);
  });

  it("rejects URL changes that collide with another connected server", async () => {
    seedServerRow({ url: "https://taken.example.com/mcp" });
    const second = seedServerRow({ url: "https://free.example.com/mcp" });

    await expect(
      updateServer(env, "user1", second.id, { url: "https://taken.example.com/mcp" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("returns 404 for servers owned by someone else (no existence leak)", async () => {
    const row = seedServerRow({ userId: "user2" });
    await expect(updateServer(env, "user1", row.id, { name: "Nope" })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("deleteServer", () => {
  it("deletes the server and cascades oauth state", async () => {
    const row = seedServerRow({ status: "pending_auth", authType: "oauth" });
    d1.sqlite
      .prepare(
        "INSERT INTO mcp_oauth_state (state, server_id, user_id, code_verifier, client_id, token_endpoint, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "state-1",
        row.id,
        "user1",
        "verifier",
        "client",
        "https://t.example.com/token",
        9999999999,
      );

    await deleteServer(env, "user1", row.id);

    expect(d1.sqlite.prepare("SELECT count(*) AS c FROM mcp_server").get()).toMatchObject({ c: 0 });
    expect(d1.sqlite.prepare("SELECT count(*) AS c FROM mcp_oauth_state").get()).toMatchObject({
      c: 0,
    });
  });

  it("returns 404 when deleting another user's server", async () => {
    const row = seedServerRow({ userId: "user2" });
    await expect(deleteServer(env, "user1", row.id)).rejects.toMatchObject({ status: 404 });
    expect(d1.sqlite.prepare("SELECT count(*) AS c FROM mcp_server").get()).toMatchObject({ c: 1 });
  });
});

describe("completeOAuth", () => {
  async function seedOauthAttempt() {
    const server = seedServerRow({ status: "pending_auth", authType: "oauth" });
    const verifier = "pkce-verifier";
    d1.sqlite
      .prepare(
        "INSERT INTO mcp_oauth_state (state, server_id, user_id, code_verifier, client_id, token_endpoint, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "state-1",
        server.id,
        "user1",
        await encryptJson(env, verifier),
        "client-1",
        "https://auth.example.com/token",
        Math.floor((Date.now() + 10 * 60 * 1000) / 1000),
      );
    return server;
  }

  it("exchanges the code, encrypts tokens, and marks the server connected", async () => {
    const server = await seedOauthAttempt();
    const tokenFetch: FetchLike = async () =>
      new Response(
        JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", token_type: "Bearer" }),
        { status: 200 },
      );

    await completeOAuth(env, "user1", { state: "state-1", code: "code-1" }, ORIGIN, tokenFetch);

    const { servers } = await listMcpServers(env, "user1");
    expect(servers[0].status).toBe("connected");
    expect(servers[0].authType).toBe("oauth");
    expect(JSON.stringify(servers[0])).not.toContain("at-1");

    // The stored blob decrypts to the token set (server-side only).
    const stored = d1.sqlite
      .prepare("SELECT encrypted_auth FROM mcp_server WHERE id = ?")
      .get(server.id) as { encrypted_auth: string };
    expect(stored.encrypted_auth).not.toContain("at-1");
    const chatView = await getConnectedServersWithAuth(env, "user1");
    expect(chatView[0].tokens?.accessToken).toBe("at-1");
  });

  it("consumes the state so replays fail", async () => {
    await seedOauthAttempt();
    const tokenFetch: FetchLike = async () =>
      new Response(JSON.stringify({ access_token: "at-1", token_type: "Bearer" }), { status: 200 });

    await completeOAuth(env, "user1", { state: "state-1", code: "code-1" }, ORIGIN, tokenFetch);
    await expect(
      completeOAuth(env, "user1", { state: "state-1", code: "code-1" }, ORIGIN, tokenFetch),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects attempts bound to a different user", async () => {
    await seedOauthAttempt();
    const tokenFetch: FetchLike = async () =>
      new Response(JSON.stringify({ access_token: "at-1", token_type: "Bearer" }), { status: 200 });

    await expect(
      completeOAuth(env, "user2", { state: "state-1", code: "code-1" }, ORIGIN, tokenFetch),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("marks the server reconnect_required when the exchange fails", async () => {
    await seedOauthAttempt();
    const tokenFetch: FetchLike = async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });

    await expect(
      completeOAuth(env, "user1", { state: "state-1", code: "code-1" }, ORIGIN, tokenFetch),
    ).rejects.toMatchObject({ status: 502 });

    const { servers } = await listMcpServers(env, "user1");
    expect(servers[0].status).toBe("reconnect_required");
    expect(servers[0].lastError).toBe("Token exchange failed (invalid_grant)");
  });
});

describe("testServer", () => {
  it("sends the stored credential and records success", async () => {
    const tokens = { accessToken: "at-1", tokenType: "Bearer" };
    const row = seedServerRow({
      authType: "oauth",
      encryptedAuth: await encryptJson(env, tokens),
    });

    let seenAuth: string | null = null;
    const fetchImpl: FetchLike = async (_input, init) => {
      seenAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), { status: 200 });
    };

    const result = await testServer(env, "user1", row.id, fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.server.status).toBe("connected");
    expect(result.server.lastTestedAt).not.toBeNull();
    expect(seenAuth).toBe("Bearer at-1");
  });

  it("marks 401 responses as reconnect_required", async () => {
    const tokens = { accessToken: "at-1", tokenType: "Bearer" };
    const row = seedServerRow({
      authType: "oauth",
      encryptedAuth: await encryptJson(env, tokens),
    });
    const fetchImpl: FetchLike = async () => new Response("nope", { status: 401 });

    const result = await testServer(env, "user1", row.id, fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.server.status).toBe("reconnect_required");
  });

  it("marks expired tokens as reconnect_required without calling the server", async () => {
    const tokens = { accessToken: "at-1", tokenType: "Bearer", expiresAt: Date.now() - 1000 };
    const row = seedServerRow({
      authType: "oauth",
      encryptedAuth: await encryptJson(env, tokens),
    });
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };

    const result = await testServer(env, "user1", row.id, fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.server.status).toBe("reconnect_required");
    expect(called).toBe(false);
  });

  it("records network failures as an error status", async () => {
    const row = seedServerRow({ authType: "none" });
    const fetchImpl: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"));

    const result = await testServer(env, "user1", row.id, fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.server.status).toBe("error");
    expect(result.server.lastError).not.toContain("ECONNREFUSED");
  });

  it("returns 404 when testing another user's server", async () => {
    const row = seedServerRow({ userId: "user2" });
    await expect(testServer(env, "user1", row.id, noAuthFetch())).rejects.toMatchObject({
      status: 404,
    });
  });
});
