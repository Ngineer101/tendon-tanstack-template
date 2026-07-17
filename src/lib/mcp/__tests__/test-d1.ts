import Database from "better-sqlite3";

import type { McpEnv } from "#/lib/mcp/config.server";

// Minimal D1Database implementation backed by an in-memory better-sqlite3
// instance. It implements only the subset of the D1 binding API that
// drizzle-orm/d1 uses (prepare/bind/all/run/raw/first/batch), returning results
// in the D1 shape so drizzle's D1 session maps them correctly. This lets domain
// logic tests run the real drizzle query builder against real SQLite without a
// Cloudflare Workers runtime.

const MCP_SERVER_DDL = `
CREATE TABLE \`mcp_server\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`user_id\` text NOT NULL,
  \`name\` text NOT NULL,
  \`url\` text NOT NULL,
  \`status\` text DEFAULT 'pending' NOT NULL,
  \`metadata\` text,
  \`encrypted_auth\` text,
  \`oauth_pending\` text,
  \`last_error\` text,
  \`last_tested_at\` integer,
  \`server_info\` text,
  \`created_at\` integer DEFAULT (unixepoch()) NOT NULL,
  \`updated_at\` integer DEFAULT (unixepoch()) NOT NULL
);
`;

type D1Meta = {
  served_by?: string;
  duration: number;
  changes: number;
  last_row_id: number | null;
  rows_read: number;
  rows_written: number;
};
type D1Result<T> = { results: T[]; success: true; meta: D1Meta };

interface BoundStatement {
  __sql: string;
  all(): D1Result<Record<string, unknown>>;
  run(): D1Result<Record<string, unknown>>;
  raw<T = unknown>(): T[];
  first<T = unknown>(): T | null;
  bind(...params: unknown[]): BoundStatement;
}

export function createTestD1(sql: string = MCP_SERVER_DDL): D1Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(sql);

  const meta = (changes: number, lastRowId: number | bigint | null): D1Meta => ({
    served_by: "test",
    duration: 0,
    changes,
    last_row_id: lastRowId == null ? null : Number(lastRowId),
    rows_read: 0,
    rows_written: changes,
  });

  const bindStatement = (
    sqlStr: string,
    stmt: Database.Statement,
    params: unknown[],
  ): BoundStatement => {
    const bound: BoundStatement = {
      __sql: sqlStr,
      all: () => ({
        results: stmt.all(...params) as Record<string, unknown>[],
        success: true as const,
        meta: meta(0, null),
      }),
      run: () => {
        const result = stmt.run(...params);
        return {
          results: [],
          success: true as const,
          meta: meta(result.changes, result.lastInsertRowid ?? null),
        };
      },
      raw: <T = unknown>(): T[] => stmt.raw().all(...params) as unknown as T[],
      first: <T = unknown>(): T | null =>
        stmt.get(...params) as Record<string, unknown> | undefined as unknown as T | null,
      bind: (...more: unknown[]) => bindStatement(sqlStr, stmt, [...params, ...more]),
    };
    return bound;
  };

  const prepare = (sqlStr: string) => {
    const stmt = db.prepare(sqlStr);
    return {
      bind: (...params: unknown[]) => bindStatement(sqlStr, stmt, params),
      all: (...params: unknown[]) => bindStatement(sqlStr, stmt, params).all(),
      run: (...params: unknown[]) => bindStatement(sqlStr, stmt, params).run(),
      raw: (...params: unknown[]) => bindStatement(sqlStr, stmt, params).raw(),
      first: (...params: unknown[]) => bindStatement(sqlStr, stmt, params).first(),
    };
  };

  const isSelectLike = (sql: string) => /^\s*(select|with|values)\b/i.test(sql);

  const client = {
    prepare,
    exec: (ddl: string) => {
      db.exec(ddl);
    },
    bind: (...params: unknown[]) => bindStatement("", db.prepare(""), params),
    batch: async (items: BoundStatement[]): Promise<D1Result<Record<string, unknown>>[]> =>
      items.map((item) => (isSelectLike(item.__sql) ? item.all() : item.run())),
    dump: () => new ArrayBuffer(0),
  };

  return client as unknown as D1Database;
}

// Derive a test env with a real D1 and the required MCP secrets. Billing is
// mocked per-test with vi.mock, so STRIPE_* can be empty.
export function createTestEnv(d1: D1Database): McpEnv {
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  return {
    DB: d1,
    MCP_ENCRYPTION_KEY: key,
    MCP_ALLOW_INSECURE_HTTP: "false",
    BETTER_AUTH_SECRET: "test-secret",
    BETTER_AUTH_URL: "http://localhost:3000",
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    STRIPE_PRO_MONTHLY_PRICE_ID: "",
    STRIPE_CREDITS_1000_PRICE_ID: "",
    STRIPE_CREDITS_5000_PRICE_ID: "",
    STRIPE_CREDITS_20000_PRICE_ID: "",
    STRIPE_TAX_ENABLED: "false",
  } as unknown as McpEnv;
}
