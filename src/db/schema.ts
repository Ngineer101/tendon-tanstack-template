import { sqliteTable, integer, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// better-auth tables
export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

// Billing tables
export const billingAccount = sqliteTable(
  "billing_account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("billing_account_user_id_unique").on(table.userId),
    uniqueIndex("billing_account_stripe_customer_id_unique").on(table.stripeCustomerId),
  ],
);

export const subscription = sqliteTable(
  "subscription",
  {
    id: text("id").primaryKey(),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccount.id, { onDelete: "cascade" }),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    stripePriceId: text("stripe_price_id"),
    plan: text("plan").notNull(),
    status: text("status").notNull(),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" })
      .notNull()
      .default(false),
    currentPeriodEnd: integer("current_period_end", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("subscription_stripe_subscription_id_unique").on(table.stripeSubscriptionId),
  ],
);

export const creditBalance = sqliteTable("credit_balance", {
  billingAccountId: text("billing_account_id")
    .primaryKey()
    .references(() => billingAccount.id, { onDelete: "cascade" }),
  balance: integer("balance").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const creditTransaction = sqliteTable(
  "credit_transaction",
  {
    id: text("id").primaryKey(),
    billingAccountId: text("billing_account_id")
      .notNull()
      .references(() => billingAccount.id, { onDelete: "cascade" }),
    amount: integer("amount").notNull(),
    type: text("type").notNull(),
    description: text("description"),
    reference: text("reference"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [uniqueIndex("credit_transaction_reference_unique").on(table.reference)],
);

export const stripeEvent = sqliteTable("stripe_event", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: integer("processed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// MCP server connections
export const mcpServer = sqliteTable(
  "mcp_server",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    status: text("status").notNull().default("requires_auth"),
    authType: text("auth_type").notNull().default("oauth"),
    // AES-256-GCM encrypted token bundle (never decrypted outside server code).
    encryptedAuth: text("encrypted_auth"),
    // Metadata reported by the MCP server during the initialize handshake.
    serverName: text("server_name"),
    serverVersion: text("server_version"),
    lastError: text("last_error"),
    lastTestedAt: integer("last_tested_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [uniqueIndex("mcp_server_user_id_url_unique").on(table.userId, table.url)],
);

// Short-lived state for in-flight MCP OAuth authorization flows.
export const mcpOauthTransaction = sqliteTable("mcp_oauth_transaction", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  serverUrl: text("server_url").notNull(),
  serverName: text("server_name").notNull(),
  // AES-256-GCM encrypted payload: client registration + PKCE verifier + endpoints.
  encryptedPayload: text("encrypted_payload").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});
