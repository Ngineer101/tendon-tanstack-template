import { eq, and } from "drizzle-orm";
import { getDb } from "#/db";
import { mcpServer, mcpOauthState } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import { getBillingSummary } from "#/lib/billing/core.server";
import {
  MCP_FREE_LIMIT,
  isSafeUrl,
  type MCPAuthStatus,
  type MCPEnv,
  type MCPServerSummary,
  type OAuthDiscoveryDocument,
} from "./config";
import { encrypt, decrypt } from "./encryption";

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function listServers(env: MCPEnv, userId: string): Promise<MCPServerSummary[]> {
  const db = getDb(env.DB);
  const servers = await db.query.mcpServer.findMany({
    where: eq(mcpServer.userId, userId),
    orderBy: (fields, { desc }) => [desc(fields.createdAt)],
  });

  return servers.map((s) => ({
    id: s.id,
    label: s.label,
    serverUrl: s.serverUrl,
    authStatus: s.authStatus as MCPAuthStatus,
    lastTestedAt: s.lastTestedAt?.toISOString() ?? null,
    lastError: s.lastError,
    createdAt: s.createdAt.toISOString(),
  }));
}

export async function getServer(env: MCPEnv, userId: string, serverId: string) {
  const db = getDb(env.DB);
  const server = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });

  if (!server) {
    throw new ApiError(404, "MCP server not found");
  }

  return server;
}

async function checkServerLimit(env: MCPEnv, userId: string) {
  const summary = await getBillingSummary(env, userId);
  const isPaying = summary.plan === "pro_monthly";

  if (isPaying) return;

  const db = getDb(env.DB);
  const count = await db.$count(mcpServer, eq(mcpServer.userId, userId));

  if (count >= MCP_FREE_LIMIT) {
    throw new ApiError(
      402,
      `Free accounts are limited to ${MCP_FREE_LIMIT} MCP servers. Upgrade to Pro for unlimited servers.`,
      {
        limit: MCP_FREE_LIMIT,
        current: count,
      },
    );
  }
}

export async function discoverOAuth(serverUrl: string): Promise<{
  discovery: OAuthDiscoveryDocument;
  discoveryUrl: string;
}> {
  const safeCheck = isSafeUrl(serverUrl);
  if (!safeCheck.valid) {
    throw new ApiError(400, safeCheck.reason ?? "Invalid server URL");
  }

  const baseUrl = serverUrl.replace(/\/$/, "");
  const wellKnownUrl = `${baseUrl}/.well-known/oauth-authorization-server`;

  let response: Response;
  try {
    response = await fetch(wellKnownUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
    });
  } catch {
    throw new ApiError(400, "Unable to reach MCP server for OAuth discovery");
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location && !isSafeUrl(location).valid) {
      throw new ApiError(400, "MCP server redirected to an unsafe URL");
    }
    throw new ApiError(400, "MCP server returned an unexpected redirect during discovery");
  }

  if (!response.ok) {
    throw new ApiError(400, `MCP server OAuth discovery failed: HTTP ${response.status}`);
  }

  let discovery: OAuthDiscoveryDocument;
  try {
    discovery = (await response.json()) as OAuthDiscoveryDocument;
  } catch {
    throw new ApiError(400, "MCP server returned invalid JSON from discovery endpoint");
  }

  if (!discovery.authorizationEndpoint || !discovery.tokenEndpoint) {
    throw new ApiError(400, "MCP server discovery is missing required endpoints");
  }

  for (const endpoint of [discovery.authorizationEndpoint, discovery.tokenEndpoint]) {
    const check = isSafeUrl(endpoint);
    if (!check.valid) {
      throw new ApiError(400, `Unsafe OAuth endpoint: ${endpoint}`);
    }
  }

  return { discovery, discoveryUrl: wellKnownUrl };
}

export async function createServer(
  env: MCPEnv,
  userId: string,
  params: { label: string; serverUrl: string },
): Promise<{ serverId: string; authorizationUrl: string; state: string }> {
  if (!params.label.trim()) {
    throw new ApiError(400, "Label is required");
  }

  if (params.label.length > 128) {
    throw new ApiError(400, "Label must be 128 characters or fewer");
  }

  await checkServerLimit(env, userId);

  const safeCheck = isSafeUrl(params.serverUrl);
  if (!safeCheck.valid) {
    throw new ApiError(400, safeCheck.reason ?? "Invalid server URL");
  }

  const baseUrl = params.serverUrl.replace(/\/$/, "");
  const { discovery } = await discoverOAuth(baseUrl);

  const db = getDb(env.DB);
  const serverId = createId("mcp");

  const pkceVerifier = generatePKCEVerifier();
  const pkceChallenge = await generatePKCEChallenge(pkceVerifier);
  const oauthState = crypto.randomUUID();
  const redirectUri = `${new URL(env.BETTER_AUTH_URL).origin}/api/mcp/callback`;

  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: "mcp-client",
    redirect_uri: redirectUri,
    state: oauthState,
    code_challenge: pkceChallenge,
    code_challenge_method: "S256",
    scope: discovery.scopesSupported?.join(" ") ?? "mcp",
  });

  const authorizationUrl = `${discovery.authorizationEndpoint}?${authParams.toString()}`;

  await db.batch([
    db.insert(mcpServer).values({
      id: serverId,
      userId,
      label: params.label.trim(),
      serverUrl: baseUrl,
      oauthDiscoveryUrl: discovery.authorizationEndpoint
        ? new URL(discovery.authorizationEndpoint).origin
        : baseUrl,
      authStatus: "pending",
    }),
    db.insert(mcpOauthState).values({
      id: createId("oauth"),
      serverId,
      codeVerifier: pkceVerifier,
      state: oauthState,
      redirectUri,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    }),
  ]);

  return { serverId, authorizationUrl, state: oauthState };
}

export async function completeOAuth(
  env: MCPEnv,
  params: { code: string; state: string },
): Promise<{ serverId: string }> {
  const db = getDb(env.DB);

  const oauthEntry = await db.query.mcpOauthState.findFirst({
    where: eq(mcpOauthState.state, params.state),
  });

  if (!oauthEntry) {
    throw new ApiError(400, "Invalid or expired OAuth state");
  }

  if (new Date() > oauthEntry.expiresAt) {
    await db.delete(mcpOauthState).where(eq(mcpOauthState.id, oauthEntry.id));
    throw new ApiError(400, "OAuth flow has expired. Please try again.");
  }

  const server = await db.query.mcpServer.findFirst({
    where: eq(mcpServer.id, oauthEntry.serverId),
  });

  if (!server) {
    throw new ApiError(404, "MCP server configuration not found");
  }

  const discovery = await discoverOAuth(server.serverUrl);

  const tokenRequestBody = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: oauthEntry.redirectUri,
    client_id: "mcp-client",
    code_verifier: oauthEntry.codeVerifier,
  });

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(discovery.discovery.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: tokenRequestBody.toString(),
      redirect: "manual",
    });
  } catch {
    throw new ApiError(400, "Unable to reach MCP server token endpoint");
  }

  if (!tokenResponse.ok) {
    let errorDetail = `HTTP ${tokenResponse.status}`;
    try {
      const errBody = (await tokenResponse.json()) as { error?: string };
      if (errBody.error) errorDetail += `: ${errBody.error}`;
    } catch {
      // ignore
    }
    throw new ApiError(400, `Token exchange failed: ${errorDetail}`);
  }

  let tokenData: { access_token: string; refresh_token?: string; expires_in?: number };
  try {
    tokenData = (await tokenResponse.json()) as typeof tokenData;
  } catch {
    throw new ApiError(400, "MCP server returned invalid token response");
  }

  if (!tokenData.access_token) {
    throw new ApiError(400, "MCP server did not return an access token");
  }

  const encryptedToken = await encrypt(env, JSON.stringify(tokenData));

  await db.batch([
    db
      .update(mcpServer)
      .set({
        encryptedAuthToken: encryptedToken,
        authStatus: "active",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(mcpServer.id, oauthEntry.serverId)),
    db.delete(mcpOauthState).where(eq(mcpOauthState.id, oauthEntry.id)),
  ]);

  return { serverId: oauthEntry.serverId };
}

export async function updateServer(
  env: MCPEnv,
  userId: string,
  serverId: string,
  params: { label?: string; serverUrl?: string },
) {
  const db = getDb(env.DB);
  const server = await getServer(env, userId, serverId);

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (params.serverUrl) {
    const safeCheck = isSafeUrl(params.serverUrl);
    if (!safeCheck.valid) {
      throw new ApiError(400, safeCheck.reason ?? "Invalid server URL");
    }
    updates.serverUrl = params.serverUrl.replace(/\/$/, "");
    updates.authStatus = "pending";
    updates.encryptedAuthToken = null;
    updates.oauthDiscoveryUrl = null;
  }

  if (params.label !== undefined) {
    if (!params.label.trim()) {
      throw new ApiError(400, "Label cannot be empty");
    }
    if (params.label.length > 128) {
      throw new ApiError(400, "Label must be 128 characters or fewer");
    }
    updates.label = params.label.trim();
  }

  await db.update(mcpServer).set(updates).where(eq(mcpServer.id, server.id));

  return { id: serverId };
}

export async function deleteServer(env: MCPEnv, userId: string, serverId: string) {
  const db = getDb(env.DB);
  await getServer(env, userId, serverId);

  await db.batch([
    db.delete(mcpOauthState).where(eq(mcpOauthState.serverId, serverId)),
    db.delete(mcpServer).where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId))),
  ]);
}

export async function testConnection(env: MCPEnv, userId: string, serverId: string) {
  const db = getDb(env.DB);
  const server = await getServer(env, userId, serverId);

  if (!server.encryptedAuthToken) {
    throw new ApiError(400, "Server is not authenticated yet");
  }

  let tokenData: { access_token: string };
  try {
    const decrypted = await decrypt(env, server.encryptedAuthToken);
    tokenData = JSON.parse(decrypted) as { access_token: string };
  } catch {
    throw new ApiError(500, "Unable to decrypt stored credentials");
  }

  try {
    const response = await fetch(server.serverUrl, {
      method: "GET",
      headers: {
        authorization: `Bearer ${tokenData.access_token}`,
        accept: "application/json",
      },
      redirect: "manual",
    });

    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }

    await db
      .update(mcpServer)
      .set({
        lastTestedAt: new Date(),
        lastError: null,
        authStatus: "active",
        updatedAt: new Date(),
      })
      .where(eq(mcpServer.id, server.id));

    return { success: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Connection test failed";

    await db
      .update(mcpServer)
      .set({
        lastTestedAt: new Date(),
        lastError: errorMessage,
        authStatus: "error",
        updatedAt: new Date(),
      })
      .where(eq(mcpServer.id, server.id));

    throw new ApiError(400, `Connection test failed: ${errorMessage}`);
  }
}

export async function reconnectServer(
  env: MCPEnv,
  userId: string,
  serverId: string,
): Promise<{ authorizationUrl: string; state: string }> {
  const server = await getServer(env, userId, serverId);
  const db = getDb(env.DB);

  if (!server.serverUrl) {
    throw new ApiError(400, "Server URL is not configured");
  }

  const { discovery } = await discoverOAuth(server.serverUrl);

  const pkceVerifier = generatePKCEVerifier();
  const pkceChallenge = await generatePKCEChallenge(pkceVerifier);
  const oauthState = crypto.randomUUID();
  const redirectUri = `${new URL(env.BETTER_AUTH_URL).origin}/api/mcp/callback`;

  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: "mcp-client",
    redirect_uri: redirectUri,
    state: oauthState,
    code_challenge: pkceChallenge,
    code_challenge_method: "S256",
    scope: discovery.scopesSupported?.join(" ") ?? "mcp",
  });

  const authorizationUrl = `${discovery.authorizationEndpoint}?${authParams.toString()}`;

  await db.batch([
    db.insert(mcpOauthState).values({
      id: createId("oauth"),
      serverId: server.id,
      codeVerifier: pkceVerifier,
      state: oauthState,
      redirectUri,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    }),
    db
      .update(mcpServer)
      .set({ authStatus: "pending", updatedAt: new Date() })
      .where(eq(mcpServer.id, server.id)),
  ]);

  return { authorizationUrl, state: oauthState };
}

function generatePKCEVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generatePKCEChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
