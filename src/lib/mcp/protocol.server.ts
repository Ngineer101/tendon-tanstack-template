import { assertSafeHttpUrl } from "./url-security.server";
import type { McpServerInfo } from "./config";

// Minimal MCP client used to verify connectivity: performs an `initialize`
// handshake over the Streamable HTTP transport and reports the server's
// identity and capabilities. No session is kept open.

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const PROBE_TIMEOUT_MS = 10_000;

export type McpProbeResult =
  | { ok: true; serverInfo: McpServerInfo }
  | { ok: false; reason: "unauthorized"; wwwAuthenticate: string | null }
  | { ok: false; reason: "error"; message: string };

interface JsonRpcResponse {
  result?: {
    protocolVersion?: string;
    capabilities?: Record<string, unknown>;
    serverInfo?: { name?: string; version?: string; title?: string };
  };
  error?: { code?: number; message?: string };
}

async function parseJsonRpcResponse(response: Response): Promise<JsonRpcResponse | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        try {
          return JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  try {
    return (await response.json()) as JsonRpcResponse;
  } catch {
    return null;
  }
}

export async function probeMcpServer(
  serverUrl: string,
  accessToken?: string,
): Promise<McpProbeResult> {
  const url = assertSafeHttpUrl(serverUrl, "Server URL");

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "tendon-tanstack-template", version: "1.0.0" },
        },
      }),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return {
      ok: false,
      reason: "error",
      message: timedOut
        ? "The server did not respond within 10 seconds"
        : "Unable to reach the server",
    };
  }

  if (response.status === 401) {
    return {
      ok: false,
      reason: "unauthorized",
      wwwAuthenticate: response.headers.get("www-authenticate"),
    };
  }
  if (response.status >= 300 && response.status < 400) {
    return {
      ok: false,
      reason: "error",
      message: "The server responded with an unexpected redirect",
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: "error",
      message: `The server responded with status ${response.status}`,
    };
  }

  const payload = await parseJsonRpcResponse(response);
  if (!payload) {
    return {
      ok: false,
      reason: "error",
      message: "The server did not return a valid MCP response",
    };
  }
  if (payload.error || !payload.result) {
    return {
      ok: false,
      reason: "error",
      message: payload.error?.message
        ? `The server rejected the handshake: ${payload.error.message.slice(0, 200)}`
        : "The server rejected the MCP handshake",
    };
  }

  const { serverInfo, capabilities, protocolVersion } = payload.result;
  return {
    ok: true,
    serverInfo: {
      name: serverInfo?.name,
      version: serverInfo?.version,
      title: serverInfo?.title,
      protocolVersion,
      capabilities: {
        tools: Boolean(capabilities && "tools" in capabilities),
        resources: Boolean(capabilities && "resources" in capabilities),
        prompts: Boolean(capabilities && "prompts" in capabilities),
      },
    },
  };
}
