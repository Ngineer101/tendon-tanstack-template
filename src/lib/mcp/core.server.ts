import { and, eq } from "drizzle-orm";

import { getDb } from "#/db";
import { mcpServer } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import { getBillingSummary } from "#/lib/billing/core.server";
import type { BillingEnv } from "#/lib/billing/config.server";
import { encrypt, decrypt } from "./encryption";
import { validateServerUrl } from "./url-validator";
import {
  discoverOAuthMetadata,
  createOAuthState,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
} from "./oauth";

export interface McpEnv extends Cloudflare.Env {
  MCP_ENCRYPTION_KEY: string;
}

const MAX_FREE_SERVERS = 3;

type McpServerRows = typeof mcpServer.$inferSelect;

export interface McpServerPublic {
  id: string;
  label: string;
  url: string;
  authType: string | null;
  status: string;
  hasAuth: boolean;
  createdAt: number;
  updatedAt: number;
}

function toPublic(server: McpServerRows): McpServerPublic {
  return {
    id: server.id,
    label: server.label,
    url: server.url,
    authType: server.authType,
    status: server.status,
    hasAuth: !!server.encryptedAuthData,
    createdAt:
      server.createdAt instanceof Date ? server.createdAt.getTime() : Number(server.createdAt),
    updatedAt:
      server.updatedAt instanceof Date ? server.updatedAt.getTime() : Number(server.updatedAt),
  };
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function checkServerLimit(env: McpEnv, userId: string): Promise<void> {
  const db = getDb(env.DB);
  const servers = await db.query.mcpServer.findMany({
    where: eq(mcpServer.userId, userId),
  });

  if (servers.length >= MAX_FREE_SERVERS) {
    const summary = await getBillingSummary(env as unknown as BillingEnv, userId);
    const isPro = summary.plan === "pro_monthly";

    if (!isPro) {
      throw new ApiError(
        402,
        `Free users can connect up to ${MAX_FREE_SERVERS} MCP servers. Upgrade to Pro for unlimited.`,
        {
          limit: MAX_FREE_SERVERS,
          current: servers.length,
        },
      );
    }
  }
}

export async function listMcpServers(env: McpEnv, userId: string): Promise<McpServerPublic[]> {
  const db = getDb(env.DB);
  const servers = await db.query.mcpServer.findMany({
    where: eq(mcpServer.userId, userId),
    orderBy: (fields) => [fields.createdAt],
  });

  return servers.map(toPublic);
}

export async function createMcpServer(
  env: McpEnv,
  userId: string,
  input: { label: string; url: string },
): Promise<McpServerPublic> {
  const urlResult = validateServerUrl(input.url);
  if (!urlResult.valid) {
    throw new ApiError(400, urlResult.error ?? "Invalid URL");
  }

  const trimmedLabel = input.label.trim();
  if (!trimmedLabel || trimmedLabel.length > 100) {
    throw new ApiError(400, "Label must be between 1 and 100 characters");
  }

  await checkServerLimit(env, userId);

  const db = getDb(env.DB);
  const id = createId("mcp");

  await db.insert(mcpServer).values({
    id,
    userId,
    label: trimmedLabel,
    url: urlResult.normalizedUrl,
    authType: null,
    status: "disconnected",
  });

  const created = await db.query.mcpServer.findFirst({
    where: eq(mcpServer.id, id),
  });

  if (!created) {
    throw new ApiError(500, "Failed to create MCP server");
  }

  return toPublic(created);
}

export async function updateMcpServer(
  env: McpEnv,
  userId: string,
  serverId: string,
  input: { label?: string; url?: string },
): Promise<McpServerPublic> {
  const db = getDb(env.DB);
  const server = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });

  if (!server) {
    throw new ApiError(404, "MCP server not found");
  }

  const updates: Partial<McpServerRows> = { updatedAt: new Date() };

  if (input.label !== undefined) {
    const trimmed = input.label.trim();
    if (!trimmed || trimmed.length > 100) {
      throw new ApiError(400, "Label must be between 1 and 100 characters");
    }
    updates.label = trimmed;
  }

  if (input.url !== undefined) {
    const urlResult = validateServerUrl(input.url);
    if (!urlResult.valid) {
      throw new ApiError(400, urlResult.error ?? "Invalid URL");
    }
    updates.url = urlResult.normalizedUrl;
    updates.status = "disconnected";
    updates.encryptedAuthData = null;
    updates.authType = null;
  }

  await db.update(mcpServer).set(updates).where(eq(mcpServer.id, serverId));

  const updated = await db.query.mcpServer.findFirst({
    where: eq(mcpServer.id, serverId),
  });

  if (!updated) {
    throw new ApiError(500, "Failed to update MCP server");
  }

  return toPublic(updated);
}

export async function deleteMcpServer(
  env: McpEnv,
  userId: string,
  serverId: string,
): Promise<{ deleted: boolean }> {
  const db = getDb(env.DB);
  const result = await db
    .delete(mcpServer)
    .where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)));

  return { deleted: result.meta.changes > 0 };
}

export async function testMcpServerConnection(
  env: McpEnv,
  userId: string,
  serverId: string,
): Promise<{ ok: boolean; error?: string }> {
  const db = getDb(env.DB);
  const server = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });

  if (!server) {
    throw new ApiError(404, "MCP server not found");
  }

  try {
    const response = await fetch(`${server.url}/health`, {
      signal: AbortSignal.timeout(5000),
      headers: server.encryptedAuthData
        ? {
            authorization: `Bearer ${await decrypt(server.encryptedAuthData, env.MCP_ENCRYPTION_KEY)}`,
          }
        : {},
    });

    const ok = response.ok || response.status === 401;
    await db
      .update(mcpServer)
      .set({ status: ok ? "connected" : "error", updatedAt: new Date() })
      .where(eq(mcpServer.id, serverId));
    return { ok };
  } catch (error) {
    await db
      .update(mcpServer)
      .set({ status: "error", updatedAt: new Date() })
      .where(eq(mcpServer.id, serverId));
    return { ok: false, error: error instanceof Error ? error.message : "Connection failed" };
  }
}

export async function discoverMcpOAuth(
  env: McpEnv,
  userId: string,
  serverId: string,
): Promise<{ authorizationUrl: string }> {
  const db = getDb(env.DB);
  const server = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });

  if (!server) {
    throw new ApiError(404, "MCP server not found");
  }

  const metadata = await discoverOAuthMetadata(server.url);
  if (!metadata) {
    throw new ApiError(
      400,
      "No OAuth metadata discovered at this server. Ensure it supports OAuth 2.0.",
    );
  }

  const clientId = `${env.BETTER_AUTH_URL}/api/mcp/oauth/callback?server_id=${serverId}`;
  const scope = metadata.scopesSupported?.join(" ") ?? "openid";

  const oauthState = await createOAuthState(server.url, metadata, clientId, scope);

  const redirectUri = `${env.BETTER_AUTH_URL}/api/mcp/oauth/callback?server_id=${serverId}`;
  const authorizationUrl = buildAuthorizationUrl(oauthState, redirectUri);

  const statePayload = JSON.stringify({
    codeVerifier: oauthState.codeVerifier,
    serverOrigin: oauthState.serverOrigin,
    tokenEndpoint: oauthState.tokenEndpoint,
    clientId: oauthState.clientId,
    scope: oauthState.scope,
    state: oauthState.state,
    serverId,
  });

  await db
    .update(mcpServer)
    .set({ authType: "oauth", oauthState: statePayload, updatedAt: new Date() })
    .where(eq(mcpServer.id, serverId));

  return { authorizationUrl };
}

export async function handleMcpOAuthCallback(
  env: McpEnv,
  serverId: string,
  code: string,
  state: string,
): Promise<{ success: boolean }> {
  const db = getDb(env.DB);
  const server = await db.query.mcpServer.findFirst({
    where: eq(mcpServer.id, serverId),
  });

  if (!server || !server.oauthState) {
    throw new ApiError(404, "MCP server or OAuth state not found");
  }

  let oauthState: {
    codeVerifier: string;
    serverOrigin: string;
    tokenEndpoint: string;
    clientId: string;
    scope: string;
    state: string;
    serverId: string;
  };

  try {
    oauthState = JSON.parse(server.oauthState);
  } catch {
    throw new ApiError(400, "Invalid OAuth state");
  }

  if (oauthState.state !== state) {
    throw new ApiError(400, "OAuth state mismatch");
  }

  const redirectUri = `${env.BETTER_AUTH_URL}/api/mcp/oauth/callback?server_id=${serverId}`;

  try {
    const tokens = await exchangeCodeForTokens(oauthState, code, redirectUri);

    const authData = JSON.stringify({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? null,
      expiresIn: tokens.expiresIn ?? null,
      tokenEndpoint: oauthState.tokenEndpoint,
      clientId: oauthState.clientId,
    });

    const encrypted = await encrypt(authData, env.MCP_ENCRYPTION_KEY);

    await db
      .update(mcpServer)
      .set({
        encryptedAuthData: encrypted,
        authType: "oauth",
        status: "connected",
        oauthState: null,
        updatedAt: new Date(),
      })
      .where(eq(mcpServer.id, serverId));
  } catch (error) {
    await db
      .update(mcpServer)
      .set({ status: "error", oauthState: null, updatedAt: new Date() })
      .where(eq(mcpServer.id, serverId));

    throw new ApiError(
      400,
      `OAuth token exchange failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  return { success: true };
}
