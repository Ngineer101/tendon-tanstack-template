import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import type { DB } from "#/db";
import * as schema from "#/db/schema";
import type { McpContext } from "./servers.server";

// 32 zero-ish bytes, base64 — a valid AES-256 key for tests only.
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

// In-memory SQLite database with the real generated migrations applied. The
// drizzle better-sqlite3 driver speaks the same SQL dialect as D1, so domain
// logic (including the raw guarded INSERT) runs unchanged.
export function createTestDb(): DB {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");

  const migrationsDir = join(process.cwd(), "drizzle");
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const content = readFileSync(join(migrationsDir, file), "utf8");
    for (const statement of content.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }

  return drizzle(sqlite, { schema }) as unknown as DB;
}

export async function createTestUser(db: DB, id: string) {
  await db.insert(schema.user).values({
    id,
    name: `User ${id}`,
    email: `${id}@example.com`,
  });
  return id;
}

export function createTestContext(db: DB, overrides: Partial<McpContext> = {}): McpContext {
  return {
    db,
    encryptionSecret: TEST_ENCRYPTION_KEY,
    urlOptions: {},
    isUnlimited: () => Promise.resolve(false),
    ...overrides,
  };
}
