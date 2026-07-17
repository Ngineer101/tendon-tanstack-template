import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FREE_MCP_SERVER_LIMIT, MCP_INSERT_CONNECTION_SQL } from "./core.server";

describe("atomic MCP connection limit persistence", () => {
  let database: Database.Database;

  beforeEach(() => {
    database = new Database(":memory:");
    database.exec(`
      CREATE TABLE mcp_server_connection (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        status TEXT NOT NULL,
        auth_data_encrypted TEXT,
        oauth_issuer TEXT,
        oauth_client_id TEXT,
        scopes TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(user_id, server_url)
      )
    `);
  });

  afterEach(() => database.close());

  function seed(status = "connected", url = `https://mcp-${crypto.randomUUID()}.example/mcp`) {
    database
      .prepare(
        `INSERT INTO mcp_server_connection
          (id, user_id, name, server_url, status, created_at, updated_at)
         VALUES (?, 'user_1', 'Server', ?, ?, unixepoch(), unixepoch())`,
      )
      .run(crypto.randomUUID(), url, status);
  }

  function connect(url: string, unlimited = false) {
    return database
      .prepare(MCP_INSERT_CONNECTION_SQL)
      .run(
        crypto.randomUUID(),
        "user_1",
        "Server",
        url,
        "encrypted",
        "https://auth.example",
        "client",
        "tools:read",
        unlimited ? 1 : 0,
        "user_1",
        url,
        "user_1",
        FREE_MCP_SERVER_LIMIT,
      );
  }

  it("rejects a fourth free connection in the same SQL statement that writes it", () => {
    seed();
    seed();
    seed();
    expect(connect("https://fourth.example/mcp").changes).toBe(0);
  });

  it("allows an entitled account to connect beyond the free limit", () => {
    seed();
    seed();
    seed();
    expect(connect("https://fourth.example/mcp", true).changes).toBe(1);
  });

  it("allows reauthorization of an active URL without consuming a slot", () => {
    const url = "https://existing.example/mcp";
    seed("connected", url);
    seed();
    seed();
    expect(connect(url).changes).toBe(1);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM mcp_server_connection WHERE status <> 'disconnected'",
        )
        .get(),
    ).toEqual({ count: 3 });
  });

  it("does not reactivate a disconnected URL when all free slots are occupied", () => {
    const url = "https://disconnected.example/mcp";
    seed("disconnected", url);
    seed();
    seed();
    seed();
    expect(connect(url).changes).toBe(0);
  });
});
