// Tests for the MCP server lifecycle: the free-tier 3-server limit, the Pro
// override, disconnected servers not counting, and cross-user authorization.
//
// The D1 + network layers are stubbed so these tests assert domain behavior
// only. The fake DB honors a `currentUserId` seam so we can verify that user A
// cannot see or modify user B's servers.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "#/lib/api-error";
import { mcpOAuthState, mcpServer, subscription } from "#/db/schema";
import type { McpEnv } from "#/lib/mcp/config.server";

// Mocks must be declared before importing the module under test so Vitest
// hoists them. We import the SUT after the mocks below.
vi.mock("#/db", () => ({
  getDb: () => fakeDb,
}));

vi.mock("./oauth.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    discoverOAuthMetadata: vi.fn(async () => ({
      authorizationEndpoint: "https://mcp.example.com/authorize",
      tokenEndpoint: "https://mcp.example.com/token",
      registrationEndpoint: undefined,
    })),
    buildAuthorizationUrl: vi.fn(async () => "https://mcp.example.com/authorize?code=..."),
    shouldAllowLocalhost: vi.fn(() => true),
    registerDynamicClient: vi.fn(async () => undefined),
  };
});

vi.mock("./ssrf.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // Bypass the real validator in these domain tests; the SSRF rules are
    // exhaustively tested in ssrf.server.test.ts.
    validateServerUrl: vi.fn((url: string) => ({
      url: url.endsWith("/") ? url : `${url}/`,
      origin: new URL(url).origin,
      hostname: new URL(url).hostname,
    })),
    safeFetch: vi.fn(async () => new Response("ok", { status: 200 })),
  };
});

const { connectServer, deleteServer, disconnectServer, editServer, listServers } =
  await import("#/lib/mcp/core.server");

interface FakeRow {
  id: string;
  userId: string;
  name: string;
  serverUrl: string;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  registrationEndpoint: string | null;
  encryptedAuth: string | null;
  status: string;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const state: {
  mcpServers: FakeRow[];
  billingAccount: { id: string; userId: string } | undefined;
  subscriptions: { plan: string; status: string }[];
  currentUserId: string;
} = {
  mcpServers: [],
  billingAccount: undefined,
  subscriptions: [],
  currentUserId: "user-a",
};

// A thenable that also exposes `.orderBy` so it satisfies both
// `await db.select().from(t).where(...)` and `.where(...).orderBy(...)`.
function whereReturn(rows: FakeRow[]) {
  return {
    orderBy: () => Promise.resolve([...rows].sort((a, b) => +a.createdAt - +b.createdAt)),
    // The fake return from drizzle's `.where()` must be awaitable, hence
    // `then`. It is intentional and scoped to this test fake.
    // eslint-disable-next-line unicorn/no-thenable
    then(onFulfilled?: (v: FakeRow[]) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve(rows).then(onFulfilled, onRejected);
    },
  };
}

const fakeDb = {
  query: {
    billingAccount: { findFirst: async () => state.billingAccount },
    mcpServer: {
      findFirst: async () => state.mcpServers.find((r) => r.userId === state.currentUserId),
    },
  },
  select: () => ({
    from: (table: unknown) => ({
      where: () => {
        const rows =
          table === mcpServer
            ? state.mcpServers.filter((r) => r.userId === state.currentUserId)
            : table === subscription
              ? (state.subscriptions as unknown as FakeRow[])
              : [];
        return whereReturn(rows as FakeRow[]);
      },
    }),
  }),
  insert: (table: unknown) => ({
    values: async (row: Partial<FakeRow>) => {
      if (table === mcpServer) {
        state.mcpServers.push({
          createdAt: new Date(),
          updatedAt: new Date(),
          ...row,
        } as FakeRow);
      }
      if (table === mcpOAuthState) {
        // ignored
      }
      return { meta: { changes: 1 } };
    },
  }),
  update: (table: unknown) => ({
    set: (patch: Partial<FakeRow>) => ({
      where: async () => {
        const row = state.mcpServers.find((r) => r.userId === state.currentUserId);
        if (row && table === mcpServer) Object.assign(row, patch, { updatedAt: new Date() });
        return { meta: { changes: row ? 1 : 0 } };
      },
    }),
  }),
  delete: (table: unknown) => ({
    where: async () => {
      if (table === mcpServer) {
        const idx = state.mcpServers.findIndex((r) => r.userId === state.currentUserId);
        if (idx >= 0) state.mcpServers.splice(idx, 1);
        return { meta: { changes: idx >= 0 ? 1 : 0 } };
      }
      return { meta: { changes: 1 } };
    },
  }),
} as unknown as import("#/db").DB;

function env(): McpEnv {
  return {
    DB: {} as D1Database,
    BETTER_AUTH_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: "secret",
    MCP_ENCRYPTION_KEY: "key",
  } as unknown as McpEnv;
}

function resetState() {
  state.mcpServers = [];
  state.billingAccount = undefined;
  state.subscriptions = [];
  state.currentUserId = "user-a";
}

beforeEach(() => {
  resetState();
});

function server(
  id: string,
  userId: string,
  serverUrl: string,
  status: string,
  encryptedAuth: string | null = null,
): FakeRow {
  return {
    id,
    userId,
    name: id,
    serverUrl: serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`,
    authorizationEndpoint: "https://mcp.example.com/authorize",
    tokenEndpoint: "https://mcp.example.com/token",
    registrationEndpoint: null,
    encryptedAuth,
    status,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const APP_ORIGIN = "http://localhost:3000";

describe("MCP server limit + authorization", () => {
  it("lets a free user connect up to 3 servers then blocks the 4th", async () => {
    for (let i = 0; i < 3; i++) {
      const result = await connectServer(
        env(),
        "user-a",
        { serverUrl: `https://mcp-${i}.example.com`, name: `s${i}` },
        APP_ORIGIN,
      );
      expect(result.authorizationUrl).toContain("https://mcp.example.com/authorize");
    }

    const listing = await listServers(env(), "user-a");
    expect(listing.used).toBe(3);
    expect(listing.limit).toBe(3);

    let caught: ApiError | undefined;
    try {
      await connectServer(
        env(),
        "user-a",
        { serverUrl: "https://mcp-3.example.com", name: "s3" },
        APP_ORIGIN,
      );
    } catch (e) {
      caught = e as ApiError;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught?.status).toBe(402);
    expect(caught?.details).toMatchObject({ code: "mcp_limit_reached", limit: 3, used: 3 });
  });

  it("does not enforce a limit for Pro subscribers", async () => {
    state.billingAccount = { id: "billing-a", userId: "user-a" };
    state.subscriptions = [{ plan: "pro_monthly", status: "active" }];

    for (let i = 0; i < 5; i++) {
      const result = await connectServer(
        env(),
        "user-a",
        { serverUrl: `https://mcp-${i}.example.com`, name: `s${i}` },
        APP_ORIGIN,
      );
      expect(result.serverId).toBeTruthy();
    }
    const listing = await listServers(env(), "user-a");
    expect(listing.limit).toBeNull();
    expect(listing.used).toBe(5);
  });

  it("does not count disconnected servers toward the limit", async () => {
    state.mcpServers = [
      server("s1", "user-a", "https://mcp-1.example.com", "connected"),
      server("s2", "user-a", "https://mcp-2.example.com", "connected"),
      server("s3", "user-a", "https://mcp-3.example.com", "disconnected"),
    ];

    const before = await listServers(env(), "user-a");
    expect(before.used).toBe(2);

    const result = await connectServer(
      env(),
      "user-a",
      { serverUrl: "https://mcp-4.example.com", name: "s4" },
      APP_ORIGIN,
    );
    expect(result.serverId).toBeTruthy();
  });

  it("listServers only returns the caller's servers", async () => {
    state.mcpServers = [
      server("s1", "user-a", "https://mcp-a.example.com", "connected"),
      server("s2", "user-b", "https://mcp-b.example.com", "connected"),
    ];
    state.currentUserId = "user-a";
    const listing = await listServers(env(), "user-a");
    expect(listing.servers).toHaveLength(1);
    expect(listing.servers[0].serverUrl).toBe("https://mcp-a.example.com/");
  });

  it("disconnects a connected server and clears credentials", async () => {
    state.mcpServers = [server("s1", "user-a", "https://mcp.example.com", "connected", "enc-blob")];
    const result = await disconnectServer(env(), "user-a", "s1");
    expect(result.status).toBe("disconnected");
    expect(result.hasCredentials).toBe(false);
    expect(state.mcpServers[0].status).toBe("disconnected");
    expect(state.mcpServers[0].encryptedAuth).toBeNull();
  });

  it("edits a server's name without resetting the connection", async () => {
    state.mcpServers = [server("s1", "user-a", "https://mcp.example.com", "connected", "enc-blob")];
    const result = await editServer(env(), "user-a", "s1", { name: "New name" }, APP_ORIGIN);
    expect(result.name).toBe("New name");
    expect(state.mcpServers[0].status).toBe("connected");
    expect(state.mcpServers[0].encryptedAuth).toBe("enc-blob");
  });

  it("rejects names that are empty or too long", async () => {
    state.mcpServers = [server("s1", "user-a", "https://mcp.example.com", "connected")];
    await expect(
      editServer(env(), "user-a", "s1", { name: "   " }, APP_ORIGIN),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      editServer(env(), "user-a", "s1", { name: "x".repeat(81) }, APP_ORIGIN),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("changing the server URL resets the connection to pending", async () => {
    state.mcpServers = [server("s1", "user-a", "https://mcp.example.com", "connected", "enc-blob")];
    const result = await editServer(
      env(),
      "user-a",
      "s1",
      { name: "renamed", serverUrl: "https://mcp-new.example.com" },
      APP_ORIGIN,
    );
    expect(result.status).toBe("pending");
    expect(result.hasCredentials).toBe(false);
  });

  it("deletes a server the caller owns", async () => {
    state.mcpServers = [server("s1", "user-a", "https://mcp.example.com", "connected")];
    await deleteServer(env(), "user-a", "s1");
    expect(state.mcpServers).toHaveLength(0);
  });

  it("returns 404 when deleting a server owned by another user", async () => {
    state.mcpServers = [server("s1", "user-b", "https://mcp.example.com", "connected")];
    state.currentUserId = "user-a";
    await expect(deleteServer(env(), "user-a", "s1")).rejects.toMatchObject({ status: 404 });
    expect(state.mcpServers).toHaveLength(1);
  });

  it("returns 404 when disconnecting a server owned by another user", async () => {
    state.mcpServers = [server("s1", "user-b", "https://mcp.example.com", "connected")];
    state.currentUserId = "user-a";
    await expect(disconnectServer(env(), "user-a", "s1")).rejects.toMatchObject({
      status: 404,
    });
    expect(state.mcpServers[0].status).toBe("connected");
  });
});
