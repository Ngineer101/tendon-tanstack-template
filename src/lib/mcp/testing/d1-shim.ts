import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

/**
 * Minimal D1Database shim backed by an in-memory better-sqlite3 database.
 * It implements exactly the surface drizzle-orm/d1 uses: prepare/bind with
 * run/all/raw, plus batch. Schema comes from the real migration files so
 * tests exercise the same DDL as production.
 */
export function createTestD1(): D1Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");

  const migrationsDir = join(__dirname, "..", "..", "..", "..", "drizzle");
  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }

  const d1 = {
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      return {
        bind(...params: unknown[]) {
          const bound = params.map((value) => (value instanceof Date ? value.getTime() : value));
          return {
            async run() {
              const info = stmt.run(...bound);
              return { success: true, meta: { changes: info.changes } };
            },
            async all() {
              return { success: true, results: stmt.all(...bound) };
            },
            async raw() {
              stmt.raw(true);
              try {
                return stmt.all(...bound);
              } finally {
                stmt.raw(false);
              }
            },
            async first() {
              return stmt.get(...bound) ?? null;
            },
          };
        },
      };
    },
    async batch(statements: Array<ReturnType<D1Database["prepare"]>>) {
      const results = [];
      for (const stmt of statements) {
        results.push(await (stmt as unknown as { all: () => Promise<unknown> }).all());
      }
      return results;
    },
  };

  return d1 as unknown as D1Database;
}

/** Base64-encoded 32-byte key, only ever used in tests. */
export const TEST_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8").toString(
  "base64",
);
