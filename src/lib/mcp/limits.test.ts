import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { canConnectMcpServer, MCP_CONNECTION_INSERT_SQL, McpConnectionLimitError } from "./limits";

describe("MCP connection limits", () => {
  it("allows free users through their third server and rejects the fourth", () => {
    expect(canConnectMcpServer(false, 0)).toBe(true);
    expect(canConnectMcpServer(false, 2)).toBe(true);
    expect(canConnectMcpServer(false, 3)).toBe(false);
  });

  it("allows paying users an unlimited number of servers", () => {
    expect(canConnectMcpServer(true, 3)).toBe(true);
    expect(canConnectMcpServer(true, 10_000)).toBe(true);
  });

  it("returns an upgrade-safe API error", () => {
    const error = new McpConnectionLimitError();
    expect(error.status).toBe(403);
    expect(error.details).toEqual({
      code: "mcp_server_limit_reached",
      limit: 3,
      upgradeUrl: "/billing",
    });
  });

  it("enforces the free limit inside the atomic insert statement", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE mcp_connection (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        status TEXT NOT NULL,
        auth_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const insert = database.prepare(MCP_CONNECTION_INSERT_SQL);

    for (let index = 1; index <= 3; index += 1) {
      expect(
        insert.run({
          1: `mcp_${index}`,
          2: "free_user",
          3: `Server ${index}`,
          4: `https://mcp${index}.example.net`,
          5: 0,
        }).changes,
      ).toBe(1);
    }
    expect(
      insert.run({ 1: "mcp_4", 2: "free_user", 3: "Server 4", 4: "https://mcp4.example.net", 5: 0 })
        .changes,
    ).toBe(0);
    expect(
      insert.run({ 1: "mcp_5", 2: "paid_user", 3: "Server 5", 4: "https://mcp5.example.net", 5: 1 })
        .changes,
    ).toBe(1);
    expect(
      insert.run({ 1: "mcp_6", 2: "paid_user", 3: "Server 6", 4: "https://mcp6.example.net", 5: 1 })
        .changes,
    ).toBe(1);
    database.close();
  });
});
