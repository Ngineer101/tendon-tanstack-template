import { afterEach, describe, expect, it, vi } from "vitest";

import { McpAuthRequiredError, parseSseMessages, performMcpHandshake } from "./client.server";

function requestBody(init?: RequestInit): { method: string; id?: number } {
  return JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
    method: string;
    id?: number;
  };
}

function requestHeader(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function initializeResult(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2025-06-18",
      serverInfo: { name: "test-server", version: "1.2.3" },
      capabilities: {},
    },
  };
}

function toolsResult(id = 2, count = 3) {
  return {
    jsonrpc: "2.0",
    id,
    result: { tools: Array.from({ length: count }, (_, i) => ({ name: `tool_${i}` })) },
  };
}

describe("parseSseMessages", () => {
  it("parses JSON-RPC messages from SSE event blocks", () => {
    const body = [
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
    ].join("\n\n");
    const messages = parseSseMessages(body);
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe(1);
    expect(messages[1].method).toBe("notifications/progress");
  });

  it("skips malformed events and multi-line data joins lines", () => {
    const body = 'data: {"jsonrpc":"2.0",\ndata: "id":5,"result":{}}\n\ndata: {not json}\n\n';
    const messages = parseSseMessages(body);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(5);
  });
});

describe("performMcpHandshake", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("handles a plain JSON initialize response and counts tools", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init);
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      const payload = body.method === "initialize" ? initializeResult() : toolsResult();
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await performMcpHandshake("https://mcp.example.com/mcp");
    expect(result).toEqual({
      serverName: "test-server",
      serverVersion: "1.2.3",
      protocolVersion: "2025-06-18",
      toolCount: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("handles SSE responses and forwards the session id", async () => {
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = requestBody(init);
        seen.push({
          method: body.method,
          session: requestHeader(init, "mcp-session-id"),
        });
        if (body.method === "initialize") {
          return new Response(
            `event: message\ndata: ${JSON.stringify(initializeResult(body.id!))}\n\n`,
            {
              status: 200,
              headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-1" },
            },
          );
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        return new Response(`data: ${JSON.stringify(toolsResult(body.id!, 7))}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const result = await performMcpHandshake("https://mcp.example.com/mcp");
    expect(result.toolCount).toBe(7);
    expect(seen.find((entry) => entry.method === "tools/list")?.session).toBe("sess-1");
  });

  it("sends the bearer token when provided", async () => {
    let authHeader: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        authHeader = requestHeader(init, "authorization");
        return new Response(JSON.stringify(initializeResult()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await performMcpHandshake("https://mcp.example.com/mcp", {
      accessToken: "token-1",
      skipToolsList: true,
    });
    expect(authHeader).toBe("Bearer token-1");
  });

  it("throws McpAuthRequiredError with the challenge header on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("Unauthorized", {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
            },
          }),
      ),
    );
    const failure = await performMcpHandshake("https://mcp.example.com/mcp").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(McpAuthRequiredError);
    expect((failure as McpAuthRequiredError).wwwAuthenticate).toContain("resource_metadata");
  });

  it("does not leak response bodies into handshake errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("internal secret: hunter2", {
            status: 500,
            headers: { "content-type": "text/plain" },
          }),
      ),
    );
    const failure = await performMcpHandshake("https://mcp.example.com/mcp").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("hunter2");
  });

  it("tolerates tools/list failures while keeping the handshake result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = requestBody(init);
        if (body.method === "initialize") {
          return new Response(JSON.stringify(initializeResult()), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("boom", { status: 500 });
      }),
    );
    const result = await performMcpHandshake("https://mcp.example.com/mcp");
    expect(result.serverName).toBe("test-server");
    expect(result.toolCount).toBeNull();
  });
});
