import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

import { getDb, type DB } from "#/db";
import { billingAccount, subscription, user } from "#/db/schema";

/**
 * Test helper: adapts better-sqlite3 to the D1Database surface that
 * drizzle-orm/d1 uses (prepare/bind/run/all/raw + batch), so domain logic can
 * be tested against the real Drizzle migrations in plain Node — no miniflare
 * required. Batch executes inside a better-sqlite3 transaction to mirror D1's
 * all-or-nothing semantics.
 */

type BindValue = null | number | bigint | string | Uint8Array;

function convertParams(params: unknown[]): BindValue[] {
  return params.map((param) => {
    if (param === undefined || param === null) return null;
    if (typeof param === "boolean") return param ? 1 : 0;
    if (typeof param === "number" || typeof param === "bigint" || typeof param === "string") {
      return param;
    }
    if (param instanceof ArrayBuffer) return new Uint8Array(param);
    if (ArrayBuffer.isView(param)) {
      return new Uint8Array(param.buffer, param.byteOffset, param.byteLength);
    }
    throw new Error(`Unsupported bind parameter in test D1 shim: ${typeof param}`);
  });
}

class ShimStatement {
  constructor(
    private readonly db: Database.Database,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new ShimStatement(this.db, this.sql, params);
  }

  private prepared() {
    return this.db.prepare(this.sql);
  }

  async run() {
    const info = this.prepared().run(...convertParams(this.params));
    return {
      success: true,
      meta: {
        changes: info.changes,
        last_row_id: Number(info.lastInsertRowid),
        duration: 0,
        rows_read: 0,
        rows_written: info.changes,
      },
    };
  }

  async all() {
    const results = this.prepared().all(...convertParams(this.params));
    return {
      success: true,
      results,
      meta: { changes: 0, last_row_id: 0, duration: 0, rows_read: results.length, rows_written: 0 },
    };
  }

  async raw() {
    return this.prepared()
      .raw()
      .all(...convertParams(this.params));
  }

  /** Used by the shim's batch implementation. */
  executeSync() {
    const stmt = this.prepared();
    if (stmt.reader) {
      const results = stmt.all(...convertParams(this.params));
      return {
        success: true,
        results,
        meta: {
          changes: 0,
          last_row_id: 0,
          duration: 0,
          rows_read: results.length,
          rows_written: 0,
        },
      };
    }
    const info = stmt.run(...convertParams(this.params));
    return {
      success: true,
      meta: {
        changes: info.changes,
        last_row_id: Number(info.lastInsertRowid),
        duration: 0,
        rows_read: 0,
        rows_written: info.changes,
      },
    };
  }
}

export function createTestDatabase(): { d1: D1Database; db: DB } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");

  const migrationsDir = join(import.meta.dirname, "../../../../drizzle");
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
    prepare: (sql: string) => new ShimStatement(sqlite, sql),
    batch: async (statements: ShimStatement[]) =>
      sqlite.transaction(() => statements.map((statement) => statement.executeSync()))(),
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => {
      throw new Error("dump() is not implemented in the test D1 shim");
    },
    withSession: () => {
      throw new Error("withSession() is not implemented in the test D1 shim");
    },
  } as unknown as D1Database;

  return { d1, db: getDb(d1) };
}

export async function seedUser(db: DB, id: string, email = `${id}@test.dev`) {
  await db.insert(user).values({ id, name: `User ${id}`, email });
  return id;
}

export async function seedProSubscription(db: DB, userId: string) {
  const accountId = `billing_${userId}`;
  await db.insert(billingAccount).values({ id: accountId, userId });
  await db.insert(subscription).values({
    id: `sub_${userId}`,
    billingAccountId: accountId,
    stripeSubscriptionId: `stripe_sub_${userId}`,
    plan: "pro_monthly",
    status: "active",
  });
}
