import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { ApiError } from "#/lib/api-error";
import * as schema from "#/db/schema";
import { McpLimitError } from "#/lib/mcp/entitlements.server";
import type { McpEnv } from "#/lib/mcp/config.server";

// --- Mocks for I/O (network, ids, env-dependent helpers) -------------------
//
// core.server.ts reaches out to the network (OAuth discovery, token exchange,
// revoke, live probe), generates random ids, and reads the plan from the
// billing module. We stub those so the domain logic (limit enforcement,
// ownership, encryption-at-rest, status transitions) can be tested
// deterministically without D1.
//
// `getDb` is mocked to return an in-memory better-sqlite3 drizzle instance that
// we create fresh per test below (matching the production schema shape).

let nextId = 0;
let currentDb: unknown;

vi.mock("#/db", () => ({
  getDb: () => currentDb,
}));

vi.mock("#/lib/mcp/id.server", () => ({
  createId: (prefix: string) => `${prefix}_${++nextId}`,
}));

vi.mock("#/lib/mcp/discovery.server", () => ({
  discover: vi.fn().mockResolvedValue({
    serverOrigin: "https://mcp.example.com",
    resource: { name: "Demo MCP" },
    authorizationServer: {
      authorization_endpoint: "https://mcp.example.com/authorize",
      token_endpoint: "https://mcp.example.com/token",
      revocation_endpoint: "https://mcp.example.com/revoke",
      registration_endpoint: "https://mcp.example.com/register",
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["tools", "resources"],
    },
  }),
  probeMcpServer: vi.fn().mockResolvedValue({ ok: true, message: "ok", status: 200 }),
}));

vi.mock("#/lib/mcp/client.server", () => ({
  registerDynamicClient: vi.fn().mockResolvedValue({
    clientId: "registered-client-id",
    clientSecret: "registered-secret",
  }),
  exchangeCodeForTokens: vi.fn().mockResolvedValue({
    accessToken: "ACCESS_TOKEN_VALUE",
    refreshToken: "REFRESH_TOKEN_VALUE",
    tokenType: "Bearer",
    expiresAt: Date.now() + 3600_000,
    scope: "tools resources",
    clientId: "registered-client-id",
    clientSecret: "registered-secret",
  }),
  revokeToken: vi.fn().mockResolvedValue(undefined),
}));

// The plan is resolved directly from D1 (billingAccount + subscription rows),
// so no billing-module mock is needed — the pro test seeds rows below.

// Fresh key each test via the in-process crypto global, so encryption-at-rest
// really runs through AES-GCM rather than being stubbed.

// ---------------------------------------------------------------------------
// Test harness: in-memory better-sqlite3 drizzle matching the production
// schema, exposed as `env.DB` (typed loosely — only what core touches).
// ---------------------------------------------------------------------------

interface Harness {
  env: McpEnv;
  sqlite: Database.Database;
  insertUser(id: string): void;
  /** Seed an active Pro subscription for `userId` so loadPlan returns pro. */
  grantPro(userId: string): void;
}

function createHarness(): Harness {
  const sqlite = new Database(":memory:");
  // Build the tables directly; production migrations live in ./drizzle.
  sqlite.exec(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE billing_account (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      stripe_customer_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    );
    CREATE TABLE subscription (
      id TEXT PRIMARY KEY NOT NULL,
      billing_account_id TEXT NOT NULL,
      stripe_subscription_id TEXT NOT NULL,
      stripe_price_id TEXT,
      plan TEXT NOT NULL,
      status TEXT NOT NULL,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      current_period_end INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (billing_account_id) REFERENCES billing_account(id) ON DELETE CASCADE
    );
    CREATE TABLE credit_balance (
      billing_account_id TEXT PRIMARY KEY NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (billing_account_id) REFERENCES billing_account(id) ON DELETE CASCADE
    );
    CREATE TABLE credit_transaction (
      id TEXT PRIMARY KEY NOT NULL,
      billing_account_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      reference TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (billing_account_id) REFERENCES billing_account(id) ON DELETE CASCADE
    );
    CREATE TABLE stripe_event (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      processed_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE mcp_server (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      server_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      auth_data_encrypted TEXT,
      discovery_meta TEXT,
      last_tested_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX mcp_server_user_url_unique ON mcp_server (user_id, server_url);
  `);

  currentDb = drizzle(sqlite, { schema });

  const env = {
    BETTER_AUTH_URL: "https://app.example.com",
    MCP_ENCRYPTION_KEY: base64url(crypto.getRandomValues(new Uint8Array(32))),
  } as unknown as McpEnv;

  return {
    env,
    sqlite,
    insertUser(id: string) {
      sqlite
        .prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)")
        .run(id, "Test", `${id}@example.com`);
    },
    grantPro(userId: string) {
      const billingAccountId = `billing_${userId}`;
      sqlite
        .prepare("INSERT INTO billing_account (id, user_id) VALUES (?, ?)")
        .run(billingAccountId, userId);
      sqlite
        .prepare(
          `INSERT INTO subscription (id, billing_account_id, stripe_subscription_id, plan, status)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(`sub_${userId}`, billingAccountId, `stripe_sub_${userId}`, "pro_monthly", "active");
    },
  };
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Import core AFTER mocks are registered so module-level bindings resolve to
// the mocked implementations.
const {
  beginConnection,
  completeConnection,
  listMcpServers,
  disconnectServer,
  testServer,
  editServer,
} = await import("#/lib/mcp/core.server");
const { probeMcpServer } = await import("#/lib/mcp/discovery.server");
const { exchangeCodeForTokens, revokeToken } = await import("#/lib/mcp/client.server");

const APP_ORIGIN = "https://app.example.com";

describe("MCP core domain logic", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
    harness.insertUser("u_owner");
    harness.insertUser("u_other");
    nextId = 0;
    vi.mocked(probeMcpServer).mockResolvedValue({ ok: true, message: "ok", status: 200 });
  });

  it("enforces the free-tier 3-server limit (allows 3, blocks the 4th)", async () => {
    for (let i = 0; i < 3; i++) {
      const result = await beginConnection(
        harness.env,
        "u_owner",
        { name: `S${i}`, serverUrl: `https://mcp${i}.example.com` },
        APP_ORIGIN,
      );
      await completeConnection(
        harness.env,
        "u_owner",
        {
          state: extractState(result.authorizationUrl),
          code: `code-${i}`,
        },
        APP_ORIGIN,
      );
    }
    const list = await listMcpServers(harness.env, "u_owner");
    expect(list.servers.length).toBe(3);
    expect(list.limit).toBe(3);
    expect(list.remaining).toBe(0);

    // 4th connection must be rejected with the limit error.
    await expect(
      beginConnection(
        harness.env,
        "u_owner",
        {
          name: "overflow",
          serverUrl: "https://mcp-other.example.com",
        },
        APP_ORIGIN,
      ),
    ).rejects.toBeInstanceOf(McpLimitError);

    // And the ApiError status code surfaces as 402 (upgrade required).
    try {
      await beginConnection(
        harness.env,
        "u_owner",
        {
          name: "overflow",
          serverUrl: "https://mcp-other.example.com",
        },
        APP_ORIGIN,
      );
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.status).toBe(402);
    }
  });

  it("pro users can connect unlimited servers", async () => {
    harness.grantPro("u_owner");

    for (let i = 0; i < 5; i++) {
      const result = await beginConnection(
        harness.env,
        "u_owner",
        { name: `S${i}`, serverUrl: `https://mcp${i}.example.com` },
        APP_ORIGIN,
      );
      await completeConnection(
        harness.env,
        "u_owner",
        {
          state: extractState(result.authorizationUrl),
          code: `code-${i}`,
        },
        APP_ORIGIN,
      );
    }
    const list = await listMcpServers(harness.env, "u_owner");
    expect(list.servers.length).toBe(5);
    expect(list.limit).toBeNull();
    expect(list.remaining).toBeNull();
  });

  it("encrypts auth tokens at rest and never returns them in the view", async () => {
    const begin = await beginConnection(
      harness.env,
      "u_owner",
      { name: "secure", serverUrl: "https://mcp.example.com" },
      APP_ORIGIN,
    );
    await completeConnection(
      harness.env,
      "u_owner",
      {
        state: extractState(begin.authorizationUrl),
        code: "code-1",
      },
      APP_ORIGIN,
    );

    // Raw row in the DB must not contain the plaintext token.
    const raw = harness.sqlite
      .prepare("SELECT auth_data_encrypted FROM mcp_server WHERE id = ?")
      .get(begin.server.id) as { auth_data_encrypted: string };
    expect(raw.auth_data_encrypted).not.toContain("ACCESS_TOKEN_VALUE");
    expect(raw.auth_data_encrypted).not.toContain("REFRESH_TOKEN_VALUE");
    expect(raw.auth_data_encrypted.length).toBeGreaterThan(0);

    // The client-facing view must not contain tokens either.
    const list = await listMcpServers(harness.env, "u_owner");
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain("ACCESS_TOKEN_VALUE");
    expect(serialized).not.toContain("REFRESH_TOKEN_VALUE");
  });

  it("ownership: a different user gets a 404, not leakage", async () => {
    const begin = await beginConnection(
      harness.env,
      "u_owner",
      { name: "mine", serverUrl: "https://mcp.example.com" },
      APP_ORIGIN,
    );

    await expect(disconnectServer(harness.env, "u_other", begin.server.id)).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(
      editServer(harness.env, "u_other", begin.server.id, { name: "hacked" }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(testServer(harness.env, "u_other", begin.server.id)).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("disconnect purges the row and attempts revocation", async () => {
    const begin = await beginConnection(
      harness.env,
      "u_owner",
      { name: "purge", serverUrl: "https://mcp.example.com" },
      APP_ORIGIN,
    );
    await completeConnection(
      harness.env,
      "u_owner",
      {
        state: extractState(begin.authorizationUrl),
        code: "code-1",
      },
      APP_ORIGIN,
    );

    await disconnectServer(harness.env, "u_owner", begin.server.id);

    const list = await listMcpServers(harness.env, "u_owner");
    expect(list.servers.length).toBe(0);

    const raw = harness.sqlite
      .prepare("SELECT id FROM mcp_server WHERE id = ?")
      .get(begin.server.id);
    expect(raw).toBeUndefined();

    expect(exchangeCodeForTokens).toHaveBeenCalled();
    // Revocation is best-effort (mocked here) and was invoked at disconnect.
    expect(vi.mocked(revokeToken)).toHaveBeenCalled();
  });

  it("test() flips status to error when the probe fails and records a sanitized error", async () => {
    vi.mocked(probeMcpServer).mockResolvedValueOnce({
      ok: false,
      message: "Authentication rejected by the MCP server",
      status: 401,
    });

    const begin = await beginConnection(
      harness.env,
      "u_owner",
      { name: "flaky", serverUrl: "https://mcp.example.com" },
      APP_ORIGIN,
    );
    await completeConnection(
      harness.env,
      "u_owner",
      {
        state: extractState(begin.authorizationUrl),
        code: "code-1",
      },
      APP_ORIGIN,
    );

    const result = await testServer(harness.env, "u_owner", begin.server.id);
    expect(result.ok).toBe(false);

    const list = await listMcpServers(harness.env, "u_owner");
    const server = list.servers.find((s) => s.id === begin.server.id);
    expect(server?.status).toBe("error");
    expect(server?.lastError).toContain("Authentication rejected");
  });

  it("editServer changing the URL resets status to pending and clears tokens", async () => {
    const begin = await beginConnection(
      harness.env,
      "u_owner",
      { name: "editable", serverUrl: "https://mcp.example.com" },
      APP_ORIGIN,
    );
    await completeConnection(
      harness.env,
      "u_owner",
      {
        state: extractState(begin.authorizationUrl),
        code: "code-1",
      },
      APP_ORIGIN,
    );

    const updated = await editServer(harness.env, "u_owner", begin.server.id, {
      serverUrl: "https://mcp2.example.com",
    });
    expect(updated.status).toBe("pending");

    const raw = harness.sqlite
      .prepare("SELECT auth_data_encrypted, discovery_meta FROM mcp_server WHERE id = ?")
      .get(begin.server.id) as {
      auth_data_encrypted: string | null;
      discovery_meta: string | null;
    };
    expect(raw.auth_data_encrypted).toBeNull();
    expect(raw.discovery_meta).toBeNull();
  });

  it("rejects duplicate URLs per user with a 409", async () => {
    await beginConnection(
      harness.env,
      "u_owner",
      {
        name: "one",
        serverUrl: "https://mcp.example.com",
      },
      APP_ORIGIN,
    );
    await expect(
      beginConnection(
        harness.env,
        "u_owner",
        {
          name: "two",
          serverUrl: "https://mcp.example.com",
        },
        APP_ORIGIN,
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("OAuth callback rejects a state that does not belong to the session user", async () => {
    const begin = await beginConnection(
      harness.env,
      "u_owner",
      { name: "owner", serverUrl: "https://mcp.example.com" },
      APP_ORIGIN,
    );
    await expect(
      completeConnection(
        harness.env,
        "u_other",
        {
          state: extractState(begin.authorizationUrl),
          code: "code-stolen",
        },
        APP_ORIGIN,
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

function extractState(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("missing state in authz url");
  return state;
}
