import type { BillingEnv } from "#/lib/billing/config.server";

export interface McpEnv extends BillingEnv {
  // 32-byte key, base64-encoded, used for AES-GCM encryption of OAuth tokens
  // and pending PKCE verifiers. Must be provisioned via `wrangler secret put`
  // in production and never committed to source or stored in the database.
  MCP_ENCRYPTION_KEY: string;
  // Optional: allow `http://` and `localhost` outbound connections for local dev.
  MCP_ALLOW_INSECURE_HTTP?: string;
}

export function getEncryptionKey(env: McpEnv): ArrayBuffer {
  const raw = env.MCP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("Missing MCP_ENCRYPTION_KEY secret");
  }

  let bytes: Uint8Array;
  try {
    bytes = base64Decode(raw);
  } catch {
    throw new Error("MCP_ENCRYPTION_KEY must be base64-encoded");
  }

  if (bytes.byteLength !== 32) {
    throw new Error("MCP_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return bytes.buffer as ArrayBuffer;
}

export function allowInsecureHttp(env: McpEnv): boolean {
  return env.MCP_ALLOW_INSECURE_HTTP === "true";
}

function base64Decode(value: string): Uint8Array {
  const cleaned = value.replace(/=+$/, "");
  const standard = cleaned.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
