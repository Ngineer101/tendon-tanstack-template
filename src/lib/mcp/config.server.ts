import type { BillingEnv } from "#/lib/billing/config.server";

export interface McpEnv extends Cloudflare.Env {
  /**
   * Secret used to derive the AES-256-GCM key that encrypts MCP credentials
   * at rest. Configure via environment secrets (`wrangler secret put`), never
   * in source code or the database. Any high-entropy string works; generate
   * one with `openssl rand -base64 32`.
   */
  MCP_ENCRYPTION_KEY: string;
}

/** The MCP API surface also reads plan entitlements from the billing core. */
export interface McpApiEnv extends McpEnv, BillingEnv {}

export function getEncryptionSecret(env: McpEnv) {
  const secret = env.MCP_ENCRYPTION_KEY;

  if (!secret || secret.length < 16) {
    throw new Error("Missing or insecure MCP encryption configuration: MCP_ENCRYPTION_KEY");
  }

  return secret;
}
