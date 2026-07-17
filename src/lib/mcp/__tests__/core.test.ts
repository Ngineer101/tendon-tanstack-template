import { describe, it, expect, vi } from "vitest";

const mockQuery = {
  mcpServer: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  mcpOauthState: {
    findFirst: vi.fn(),
  },
};

const mockDb = {
  query: mockQuery,
  $count: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  batch: vi.fn(),
};

vi.mock("#/db", () => ({
  getDb: () => mockDb,
}));

vi.mock("#/lib/billing/core.server", () => ({
  getBillingSummary: vi.fn(),
}));

import type { MCPEnv } from "#/lib/mcp/config";
import { MCP_FREE_LIMIT } from "#/lib/mcp/config";
import {
  listServers,
  getServer,
  createServer,
  updateServer,
  deleteServer,
  testConnection,
  reconnectServer,
} from "#/lib/mcp/core.server";
import { getBillingSummary } from "#/lib/billing/core.server";

function makeEnv(overrides: Partial<MCPEnv> = {}): MCPEnv {
  return {
    BETTER_AUTH_URL: "https://example.com",
    MCP_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    DB: {} as D1Database,
    STRIPE_SECRET_KEY: "sk_test",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    STRIPE_PRO_MONTHLY_PRICE_ID: "price_123",
    STRIPE_CREDITS_1000_PRICE_ID: "price_456",
    STRIPE_CREDITS_5000_PRICE_ID: "price_789",
    STRIPE_CREDITS_20000_PRICE_ID: "price_000",
    ...overrides,
  } as MCPEnv;
}

const USER_A = "user_a";
const USER_B = "user_b";

function makeServerRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "mcp_srv1",
    userId: USER_A,
    label: "Test Server",
    serverUrl: "https://mcp.example.com",
    oauthDiscoveryUrl: "https://auth.example.com",
    encryptedAuthToken: null,
    authStatus: "pending",
    lastTestedAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("listServers", () => {
  it("returns an empty array when user has no servers", async () => {
    mockQuery.mcpServer.findMany.mockResolvedValue([]);
    const result = await listServers(makeEnv(), USER_A);
    expect(result).toEqual([]);
    expect(mockQuery.mcpServer.findMany).toHaveBeenCalled();
  });

  it("returns mapped server summaries", async () => {
    const now = new Date();
    mockQuery.mcpServer.findMany.mockResolvedValue([
      {
        id: "mcp_1",
        userId: USER_A,
        label: "Server 1",
        serverUrl: "https://a.example.com",
        authStatus: "active",
        lastTestedAt: now,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        oauthDiscoveryUrl: null,
        encryptedAuthToken: null,
      },
    ]);

    const result = await listServers(makeEnv(), USER_A);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("mcp_1");
    expect(result[0].authStatus).toBe("active");
    expect(result[0].lastTestedAt).toBe(now.toISOString());
  });
});

describe("getServer", () => {
  it("returns the server when found", async () => {
    const record = makeServerRecord();
    mockQuery.mcpServer.findFirst.mockResolvedValue(record);

    const result = await getServer(makeEnv(), USER_A, "mcp_srv1");
    expect(result).toEqual(record);
  });

  it("throws 404 when server not found", async () => {
    mockQuery.mcpServer.findFirst.mockResolvedValue(undefined);

    await expect(getServer(makeEnv(), USER_A, "nonexistent")).rejects.toMatchObject({
      status: 404,
      message: "MCP server not found",
    });
  });

  it("throws 404 when server belongs to a different user", async () => {
    mockQuery.mcpServer.findFirst.mockResolvedValue(undefined);
    await expect(getServer(makeEnv(), USER_B, "mcp_srv1")).rejects.toMatchObject({
      status: 404,
      message: "MCP server not found",
    });
  });
});

describe("createServer limit enforcement", () => {
  it("allows creation when under limit for free user", async () => {
    vi.mocked(getBillingSummary).mockResolvedValue({
      credits: 0,
      plan: "free",
      subscriptions: [],
      recentTransactions: [],
    } as Awaited<ReturnType<typeof getBillingSummary>>);

    mockDb.$count.mockResolvedValue(2);
    mockDb.insert.mockReturnValue({ values: vi.fn() });
    mockDb.batch.mockResolvedValue([]);

    await expect(
      createServer(makeEnv(), USER_A, {
        label: "Test",
        serverUrl: "https://mcp.example.com",
      }),
    ).rejects.toThrow();
  });

  it("throws 402 when free user has exactly 3 servers", async () => {
    vi.mocked(getBillingSummary).mockResolvedValue({
      credits: 0,
      plan: "free",
      subscriptions: [],
      recentTransactions: [],
    } as Awaited<ReturnType<typeof getBillingSummary>>);

    mockDb.$count.mockResolvedValue(MCP_FREE_LIMIT);

    await expect(
      createServer(makeEnv(), USER_A, {
        label: "Test",
        serverUrl: "https://mcp.example.com",
      }),
    ).rejects.toMatchObject({
      status: 402,
    });
  });

  it("throws 402 when free user has more than 3 servers", async () => {
    vi.mocked(getBillingSummary).mockResolvedValue({
      credits: 0,
      plan: "free",
      subscriptions: [],
      recentTransactions: [],
    } as Awaited<ReturnType<typeof getBillingSummary>>);

    mockDb.$count.mockResolvedValue(5);

    await expect(
      createServer(makeEnv(), USER_A, {
        label: "Test",
        serverUrl: "https://mcp.example.com",
      }),
    ).rejects.toMatchObject({
      status: 402,
    });
  });
});

describe("createServer input validation", () => {
  it("throws 400 when label is empty", async () => {
    await expect(
      createServer(makeEnv(), USER_A, {
        label: "   ",
        serverUrl: "https://mcp.example.com",
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Label is required",
    });
  });

  it("throws 400 when label exceeds 128 characters", async () => {
    await expect(
      createServer(makeEnv(), USER_A, {
        label: "x".repeat(129),
        serverUrl: "https://mcp.example.com",
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Label must be 128 characters or fewer",
    });
  });

  it("throws 400 for unsafe URL", async () => {
    await expect(
      createServer(makeEnv(), USER_A, {
        label: "Test",
        serverUrl: "http://insecure.com",
      }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it("throws 400 for localhost URL", async () => {
    await expect(
      createServer(makeEnv(), USER_A, {
        label: "Test",
        serverUrl: "https://localhost:3000",
      }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("updateServer", () => {
  it("throws 400 when label is empty", async () => {
    mockQuery.mcpServer.findFirst.mockResolvedValue(makeServerRecord());

    await expect(
      updateServer(makeEnv(), USER_A, "mcp_srv1", { label: "   " }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Label cannot be empty",
    });
  });

  it("throws 400 when label exceeds 128 chars", async () => {
    mockQuery.mcpServer.findFirst.mockResolvedValue(makeServerRecord());

    await expect(
      updateServer(makeEnv(), USER_A, "mcp_srv1", { label: "x".repeat(129) }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Label must be 128 characters or fewer",
    });
  });

  it("throws 400 for unsafe URL in update", async () => {
    mockQuery.mcpServer.findFirst.mockResolvedValue(makeServerRecord());

    await expect(
      updateServer(makeEnv(), USER_A, "mcp_srv1", { serverUrl: "http://insecure.com" }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it("throws 404 for non-existent server", async () => {
    mockQuery.mcpServer.findFirst.mockResolvedValue(undefined);

    await expect(
      updateServer(makeEnv(), USER_A, "nonexistent", { label: "New" }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("throws 404 when a different user tries to update", async () => {
    mockQuery.mcpServer.findFirst.mockResolvedValue(undefined);

    await expect(
      updateServer(makeEnv(), USER_B, "mcp_srv1", { label: "Hijack" }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("deleteServer", () => {
  it("throws 404 for non-existent server", async () => {
    mockQuery.mcpServer.findFirst.mockResolvedValue(undefined);

    await expect(deleteServer(makeEnv(), USER_A, "nonexistent")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("throws 404 when a different user tries to delete", async () => {
    mockQuery.mcpServer.findFirst.mockResolvedValue(undefined);

    await expect(deleteServer(makeEnv(), USER_B, "mcp_srv1")).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("testConnection", () => {
  it("throws 400 when server is not authenticated", async () => {
    mockQuery.mcpServer.findFirst.mockResolvedValue(makeServerRecord({ encryptedAuthToken: null }));

    await expect(testConnection(makeEnv(), USER_A, "mcp_srv1")).rejects.toMatchObject({
      status: 400,
      message: "Server is not authenticated yet",
    });
  });
});

describe("reconnectServer", () => {
  it("throws 400 when server URL is not configured", async () => {
    mockQuery.mcpServer.findFirst.mockResolvedValue(makeServerRecord({ serverUrl: null }));

    await expect(reconnectServer(makeEnv(), USER_A, "mcp_srv1")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("throws 404 for non-existent server", async () => {
    mockQuery.mcpServer.findFirst.mockResolvedValue(undefined);

    await expect(reconnectServer(makeEnv(), USER_A, "nonexistent")).rejects.toMatchObject({
      status: 404,
    });
  });
});
