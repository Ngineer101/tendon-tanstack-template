import { ApiError } from "#/lib/api-error";

export interface McpEnv extends Cloudflare.Env {
  MCP_TOKEN_ENCRYPTION_KEY: string;
}

export function getMcpEncryptionKey(env: McpEnv) {
  const key = env.MCP_TOKEN_ENCRYPTION_KEY;
  if (!key) {
    throw new ApiError(500, "MCP server connections are not configured on this deployment");
  }
  return key;
}
