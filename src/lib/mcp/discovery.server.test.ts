import { describe, expect, it } from "vitest";

import { discoverMcpAuth } from "./discovery.server";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Records calls and routes them to handlers by URL prefix. */
function mockFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return handler(init);
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

const SERVER = "https://mcp.example.com/mcp";

describe("discoverMcpAuth", () => {
  it("reports no auth when the endpoint accepts an unauthenticated initialize", async () => {
    const { fetchImpl } = mockFetch({
      [SERVER]: () => jsonResponse({ jsonrpc: "2.0", id: "tendon-probe", result: {} }),
    });

    const result = await discoverMcpAuth(SERVER, fetchImpl);
    expect(result.requiresAuth).toBe(false);
    expect(result.metadata).toBeUndefined();
  });

  it("uses RFC 8414 metadata when the probe is answered with 401", async () => {
    const { fetchImpl, calls } = mockFetch({
      [SERVER]: () => new Response("unauthorized", { status: 401 }),
      "https://mcp.example.com/.well-known/oauth-authorization-server": () =>
        jsonResponse({
          issuer: "https://mcp.example.com",
          authorization_endpoint: "https://mcp.example.com/oauth/authorize",
          token_endpoint: "https://mcp.example.com/oauth/token",
          registration_endpoint: "https://mcp.example.com/oauth/register",
        }),
    });

    const result = await discoverMcpAuth(SERVER, fetchImpl);
    expect(result.requiresAuth).toBe(true);
    expect(result.metadata).toEqual({
      authorizationEndpoint: "https://mcp.example.com/oauth/authorize",
      tokenEndpoint: "https://mcp.example.com/oauth/token",
      registrationEndpoint: "https://mcp.example.com/oauth/register",
    });
    expect(calls.some((call) => call.url.includes("oauth-authorization-server"))).toBe(true);
  });

  it("follows RFC 9728 protected-resource metadata to the authorization server", async () => {
    const { fetchImpl } = mockFetch({
      [SERVER]: () =>
        new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        }),
      "https://mcp.example.com/.well-known/oauth-protected-resource": () =>
        jsonResponse({
          resource: SERVER,
          authorization_servers: ["https://auth.example.com"],
        }),
      "https://auth.example.com/.well-known/oauth-authorization-server": () =>
        jsonResponse({
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
        }),
    });

    const result = await discoverMcpAuth(SERVER, fetchImpl);
    expect(result.requiresAuth).toBe(true);
    expect(result.metadata?.authorizationEndpoint).toBe("https://auth.example.com/authorize");
    expect(result.metadata?.tokenEndpoint).toBe("https://auth.example.com/token");
  });

  it("falls back to MCP spec default endpoints when no metadata exists", async () => {
    const { fetchImpl } = mockFetch({
      [SERVER]: () => new Response("unauthorized", { status: 401 }),
    });

    const result = await discoverMcpAuth(SERVER, fetchImpl);
    expect(result.requiresAuth).toBe(true);
    expect(result.metadata).toEqual({
      authorizationEndpoint: "https://mcp.example.com/authorize",
      tokenEndpoint: "https://mcp.example.com/token",
      registrationEndpoint: "https://mcp.example.com/register",
    });
  });

  it("rejects metadata pointing at private addresses (SSRF via discovery)", async () => {
    const { fetchImpl } = mockFetch({
      [SERVER]: () => new Response("unauthorized", { status: 401 }),
      "https://mcp.example.com/.well-known/oauth-authorization-server": () =>
        jsonResponse({
          authorization_endpoint: "https://169.254.169.254/authorize",
          token_endpoint: "https://169.254.169.254/token",
        }),
    });

    await expect(discoverMcpAuth(SERVER, fetchImpl)).rejects.toThrowError(
      expect.objectContaining({ status: 502 }),
    );
  });

  it("throws a sanitized 502 when the server cannot be reached", async () => {
    const fetchImpl: FetchLike = () =>
      Promise.reject(new Error("getaddrinfo ENOTFOUND host key=abc"));

    await expect(discoverMcpAuth(SERVER, fetchImpl)).rejects.toThrowError(
      expect.objectContaining({
        status: 502,
        message: "Unable to reach the MCP server. Check the URL and try again.",
      }),
    );
  });
});
