// Shared helpers for MCP domain tests. Uses better-sqlite3 with the real drizzle
// migration files so tests exercise the same schema that ships to D1.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import type { DB } from "#/db";
import * as schema from "#/db/schema";
import type { McpDeps } from "./core.server";

// Deterministic 32-byte AES key (base64) for tests only.
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

export interface TestDb {
  db: DB;
  sqlite: Database.Database;
}

export function createTestDb(): TestDb {
  const sqlite = new Database(":memory:");
  const migrationsDir = path.join(process.cwd(), "drizzle");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.exec(statement);
    }
  }
  const db = drizzle(sqlite, { schema }) as unknown as DB;
  return { db, sqlite };
}

export async function seedUser(db: DB, id: string) {
  await db.insert(schema.user).values({
    id,
    name: `User ${id}`,
    email: `${id}@example.com`,
  });
}

export function createDeps(db: DB, fetchFn?: typeof fetch): McpDeps {
  return { db, encryptionKey: TEST_ENCRYPTION_KEY, fetchFn };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

export function initializeResult(id: number, serverInfo = { name: "Test MCP", version: "2.1.0" }) {
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo },
  });
}

export function toolsResult(id: number, toolCount: number) {
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    result: { tools: Array.from({ length: toolCount }, (_, i) => ({ name: `tool_${i}` })) },
  });
}

function parseRpc(init?: RequestInit): { method?: string; id?: number } {
  if (typeof init?.body !== "string") return {};
  try {
    return JSON.parse(init.body) as { method?: string; id?: number };
  } catch {
    return {};
  }
}

export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

export function requestBody(init?: RequestInit): string {
  return typeof init?.body === "string" ? init.body : "";
}

// A public MCP server that needs no auth and exposes `toolCount` tools.
export function publicMcpFetch(toolCount = 2): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const rpc = parseRpc(init);
    if (rpc.method === "initialize") return initializeResult(rpc.id ?? 1);
    if (rpc.method === "tools/list") return toolsResult(rpc.id ?? 2, toolCount);
    return new Response(null, { status: 202 });
  }) as typeof fetch;
}

// A full OAuth world: MCP server at mcp.example.com requiring a Bearer token,
// authorization server at auth.example.com with DCR and token endpoints.
export function createOauthWorld() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const state = {
    accessToken: "secret-access-token-12345",
    refreshToken: "secret-refresh-token-67890",
    refreshedAccessToken: "rotated-access-token-99999",
    clientId: "client-abc",
    refreshCalls: 0,
    tokenRequests: [] as URLSearchParams[],
  };

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    calls.push({ url, init });
    const rpc = parseRpc(init);

    if (url.startsWith("https://mcp.example.com/mcp")) {
      const authHeader = new Headers(init?.headers).get("authorization");
      const authorized =
        authHeader === `Bearer ${state.accessToken}` ||
        authHeader === `Bearer ${state.refreshedAccessToken}`;
      if (!authorized) {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
          },
        });
      }
      if (rpc.method === "initialize") return initializeResult(rpc.id ?? 1);
      if (rpc.method === "tools/list") return toolsResult(rpc.id ?? 2, 3);
      return new Response(null, { status: 202 });
    }

    if (url === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") {
      return jsonResponse({
        resource: "https://mcp.example.com/mcp",
        authorization_servers: ["https://auth.example.com"],
        scopes_supported: ["mcp:tools"],
      });
    }

    if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
      return jsonResponse({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: "https://auth.example.com/register",
      });
    }

    if (url === "https://auth.example.com/register") {
      return jsonResponse({ client_id: state.clientId }, { status: 201 });
    }

    if (url === "https://auth.example.com/token") {
      const params = new URLSearchParams(requestBody(init));
      state.tokenRequests.push(params);
      if (params.get("grant_type") === "refresh_token") {
        if (params.get("refresh_token") !== state.refreshToken) {
          return jsonResponse({ error: "invalid_grant" }, { status: 400 });
        }
        state.refreshCalls += 1;
        return jsonResponse({
          access_token: state.refreshedAccessToken,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (params.get("code") !== "good-code" || !params.get("code_verifier")) {
        return jsonResponse({ error: "invalid_grant" }, { status: 400 });
      }
      return jsonResponse({
        access_token: state.accessToken,
        token_type: "Bearer",
        refresh_token: state.refreshToken,
        expires_in: 3600,
        scope: "mcp:tools",
      });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return { fetchFn, calls, state };
}
