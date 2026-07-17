import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal D1Database-compatible shim backed by better-sqlite3, implementing
 * exactly the surface drizzle-orm/d1 uses: prepare/bind/run/all/raw and
 * batch. Schema is created by applying the real migration files from
 * `drizzle/`, so tests always run against the production schema.
 *
 * Only used by tests; never imported by application code.
 */

function toSqliteParams(params: unknown[]): unknown[] {
  return params.map((param) => (param === undefined ? null : param));
}

class MockD1PreparedStatement {
  constructor(
    private readonly db: Database.Database,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new MockD1PreparedStatement(this.db, this.sql, toSqliteParams(params));
  }

  private runSync() {
    const result = this.db.prepare(this.sql).run(...this.params);
    return {
      results: [],
      success: true,
      meta: {
        changes: result.changes,
        last_row_id: Number(result.lastInsertRowid),
        duration: 0,
      },
    };
  }

  private allSync() {
    const rows = this.db.prepare(this.sql).all(...this.params);
    return { results: rows, success: true, meta: { changes: 0, duration: 0 } };
  }

  async run() {
    return this.runSync();
  }

  async all() {
    return this.allSync();
  }

  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row ?? null;
  }

  async raw() {
    return this.db
      .prepare(this.sql)
      .raw()
      .all(...this.params);
  }

  isSelect() {
    return /^\s*(select|with)/i.test(this.sql) || /returning/i.test(this.sql);
  }

  batchResult() {
    return this.isSelect() ? this.allSync() : this.runSync();
  }
}

class MockD1Database {
  constructor(private readonly db: Database.Database) {}

  prepare(sql: string) {
    return new MockD1PreparedStatement(this.db, sql);
  }

  async batch(statements: MockD1PreparedStatement[]) {
    const runAll = this.db.transaction(() =>
      statements.map((statement) => statement.batchResult()),
    );
    return runAll();
  }

  async exec(sql: string) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }

  /** Escape hatch for seeding data in tests. */
  get sqlite() {
    return this.db;
  }
}

export interface MockD1 extends D1Database {
  sqlite: Database.Database;
}

function migrationsDir() {
  // Vitest runs from the project root.
  return join(process.cwd(), "drizzle");
}

export function createMockD1(): MockD1 {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  const files = readdirSync(migrationsDir())
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir(), file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) db.exec(trimmed);
    }
  }

  return new MockD1Database(db) as unknown as MockD1;
}

export function seedUser(d1: MockD1, id: string, email = `${id}@example.com`) {
  d1.sqlite
    .prepare("INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, 1)")
    .run(id, id, email);
}

export function seedProSubscription(d1: MockD1, userId: string) {
  const billingId = `billing_${userId}`;
  d1.sqlite
    .prepare("INSERT INTO billing_account (id, user_id) VALUES (?, ?)")
    .run(billingId, userId);
  d1.sqlite
    .prepare(
      "INSERT INTO subscription (id, billing_account_id, stripe_subscription_id, plan, status) VALUES (?, ?, ?, 'pro_monthly', 'active')",
    )
    .run(`sub_${userId}`, billingId, `stripe_sub_${userId}`);
}
