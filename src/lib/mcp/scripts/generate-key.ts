// One-off helper to generate a fresh MCP_ENCRYPTION_KEY for `.env.local`.
//
// Usage:
//   pnpm exec tsx src/lib/mcp/scripts/generate-key.ts
//
// The printed key is base64-encoded raw 32 bytes and is intended for the
// `MCP_ENCRYPTION_KEY` environment variable. Never commit it; set it via
// `.env.local` locally and `wrangler secret put MCP_ENCRYPTION_KEY` in prod.

import { generateEncryptionKey } from "../crypto.server.ts";

console.log(generateEncryptionKey());
