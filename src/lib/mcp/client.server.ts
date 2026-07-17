import { ApiError } from "#/lib/api-error";
import { readJsonSafely, readTextSafely, safeFetch } from "./http.server";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "tanstack-start-app", version: "1.0.0" };

/** Thrown when the MCP server responds 401 to an unauthenticated request. */
export class McpAuthRequiredError extends Error {
  constructor(public readonly wwwAuthenticate: string | null) {
    super("MCP server requires OAuth authorization");
    this.name = "McpAuthRequiredError";
  }
}

export interface McpHandshakeResult {
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  toolCount: number | null;
}

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Parses `text/event-stream` payloads into individual JSON-RPC messages.
 * Only `data:` fields of complete events are considered.
 */
export function parseSseMessages(body: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const eventBlock of body.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const line of eventBlock.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (!dataLines.length) continue;
    try {
      const parsed = JSON.parse(dataLines.join("\n")) as JsonRpcMessage;
      if (parsed && parsed.jsonrpc === "2.0") messages.push(parsed);
    } catch {
      // Ignore malformed events; the handshake fails cleanly when no
      // matching response is found.
    }
  }
  return messages;
}

interface JsonRpcOptions {
  accessToken?: string;
  sessionId?: string;
  /** True for notifications where the server may answer 202 with no body. */
  expectNoContent?: boolean;
}

async function postJsonRpc(
  serverUrl: string,
  message: JsonRpcMessage,
  options: JsonRpcOptions = {},
): Promise<{ response?: JsonRpcMessage; sessionId?: string }> {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  if (options.accessToken) headers.set("authorization", `Bearer ${options.accessToken}`);
  if (options.sessionId) headers.set("mcp-session-id", options.sessionId);

  const response = await safeFetch(serverUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });

  if (response.status === 401) {
    throw new McpAuthRequiredError(response.headers.get("www-authenticate"));
  }
  const sessionId = response.headers.get("mcp-session-id") ?? options.sessionId;

  if (response.status === 202 && options.expectNoContent) {
    return { sessionId };
  }
  if (!response.ok) {
    throw new ApiError(502, "The MCP server rejected the connection");
  }

  const contentType = response.headers.get("content-type") ?? "";
  let rpcResponse: JsonRpcMessage | undefined;
  if (contentType.includes("text/event-stream")) {
    const body = await readTextSafely(response);
    rpcResponse = body
      ? parseSseMessages(body).find((candidate) => candidate.id === message.id)
      : undefined;
  } else if (contentType.includes("application/json")) {
    const parsed = (await readJsonSafely(response)) as JsonRpcMessage | null;
    if (parsed && parsed.jsonrpc === "2.0") rpcResponse = parsed;
  }

  if (!rpcResponse) {
    throw new ApiError(502, "The MCP server returned an unexpected response");
  }
  if (rpcResponse.error) {
    throw new ApiError(502, "The MCP server failed the handshake");
  }
  return { response: rpcResponse, sessionId };
}

/**
 * Performs the MCP `initialize` handshake (Streamable HTTP transport) and,
 * unless skipped, a best-effort `tools/list` to report the available tool
 * count. Throws `McpAuthRequiredError` when the server demands OAuth.
 */
export async function performMcpHandshake(
  serverUrl: string,
  options: { accessToken?: string; skipToolsList?: boolean } = {},
): Promise<McpHandshakeResult> {
  const init = await postJsonRpc(
    serverUrl,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    },
    options,
  );

  const result = (init.response?.result ?? {}) as {
    protocolVersion?: unknown;
    serverInfo?: { name?: unknown; version?: unknown };
  };

  let toolCount: number | null = null;
  if (!options.skipToolsList) {
    try {
      await postJsonRpc(
        serverUrl,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { ...options, sessionId: init.sessionId, expectNoContent: true },
      );
      const tools = await postJsonRpc(
        serverUrl,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { ...options, sessionId: init.sessionId },
      );
      const list = (tools.response?.result as { tools?: unknown } | undefined)?.tools;
      if (Array.isArray(list)) toolCount = list.length;
    } catch (error) {
      if (error instanceof McpAuthRequiredError) throw error;
      // tools/list is best-effort: some servers require session semantics we
      // do not fully implement; a missing tool count must not fail the test.
    }
  }

  return {
    serverName: typeof result.serverInfo?.name === "string" ? result.serverInfo.name : null,
    serverVersion:
      typeof result.serverInfo?.version === "string" ? result.serverInfo.version : null,
    protocolVersion: typeof result.protocolVersion === "string" ? result.protocolVersion : null,
    toolCount,
  };
}
