import { describe, expect, it } from "vitest";

import { ApiError } from "#/lib/api-error";
import {
  buildAuthorizationUrl,
  discoverOAuthConfig,
  exchangeAuthorizationCode,
  generatePkcePair,
  parseResourceMetadataUrl,
  probeMcpServer,
} from "./discovery.server";
import {
  createOauthWorld,
  initializeResult,
  jsonResponse,
  publicMcpFetch,
  requestBody,
  requestUrl,
  toolsResult,
} from "./test-helpers";

const SERVER_URL = "https://mcp.example.com/mcp";

describe("parseResourceMetadataUrl", () => {
  it("extracts the resource_metadata URL from a WWW-Authenticate header", () => {
    expect(
      parseResourceMetadataUrl(
        'Bearer error="unauthorized", resource_metadata="https://x.example.com/.well-known/oauth-protected-resource"',
      ),
    ).toBe("https://x.example.com/.well-known/oauth-protected-resource");
    expect(parseResourceMetadataUrl("Bearer realm=api")).toBeUndefined();
    expect(parseResourceMetadataUrl(null)).toBeUndefined();
  });
});

describe("probeMcpServer", () => {
  it("returns server info and tool count for a JSON server", async () => {
    const probe = await probeMcpServer(SERVER_URL, undefined, { fetchFn: publicMcpFetch(5) });
    expect(probe).toEqual({
      status: "ok",
      serverName: "Test MCP",
      serverVersion: "2.1.0",
      toolCount: 5,
    });
  });

  it("parses SSE responses", async () => {
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const rpc = JSON.parse(requestBody(init)) as { method: string; id: number };
      if (rpc.method === "initialize") {
        const body = [
          ": comment",
          "",
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { serverInfo: { name: "SSE MCP", version: "0.1.0" } },
          })}`,
          "",
          "",
        ].join("\n");
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(null, { status: 405 });
    }) as typeof fetch;

    const probe = await probeMcpServer(SERVER_URL, undefined, { fetchFn });
    expect(probe.status).toBe("ok");
    if (probe.status === "ok") {
      expect(probe.serverName).toBe("SSE MCP");
    }
  });

  it("parses SSE responses with CRLF line endings", async () => {
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const rpc = JSON.parse(requestBody(init)) as { method: string; id: number };
      if (rpc.method === "initialize") {
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { serverInfo: { name: "CRLF MCP", version: "1.0.0" } },
        });
        return new Response(`event: message\r\ndata: ${payload}\r\n\r\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(null, { status: 405 });
    }) as typeof fetch;

    const probe = await probeMcpServer(SERVER_URL, undefined, { fetchFn });
    expect(probe.status).toBe("ok");
    if (probe.status === "ok") {
      expect(probe.serverName).toBe("CRLF MCP");
    }
  });

  it("reports auth_required with the advertised metadata URL on 401", async () => {
    const { fetchFn } = createOauthWorld();
    const probe = await probeMcpServer(SERVER_URL, undefined, { fetchFn });
    expect(probe).toEqual({
      status: "auth_required",
      resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    });
  });

  it("still connects when tools/list fails", async () => {
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const rpc = JSON.parse(requestBody(init)) as { method: string; id: number };
      if (rpc.method === "initialize") return initializeResult(rpc.id);
      return new Response(null, { status: 500 });
    }) as typeof fetch;
    const probe = await probeMcpServer(SERVER_URL, undefined, { fetchFn });
    expect(probe.status).toBe("ok");
    if (probe.status === "ok") expect(probe.toolCount).toBeUndefined();
  });

  it("maps server errors to a 502 ApiError without leaking the URL", async () => {
    const fetchFn = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const error = await probeMcpServer(SERVER_URL, undefined, { fetchFn }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).details?.code).toBe("unreachable");
  });

  it("refuses to follow redirects", async () => {
    const fetchFn = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.com" },
      })) as typeof fetch;
    await expect(probeMcpServer(SERVER_URL, undefined, { fetchFn })).rejects.toMatchObject({
      status: 502,
    });
  });

  it("maps network failures to a 502 without the raw error", async () => {
    const fetchFn = (async () => {
      throw new Error("connect ECONNREFUSED https://mcp.example.com/mcp?apikey=secret");
    }) as typeof fetch;
    const error = await probeMcpServer(SERVER_URL, undefined, { fetchFn }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).not.toContain("apikey=secret");
  });

  it("rejects unsafe URLs before any network call", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return initializeResult(1);
    }) as typeof fetch;
    await expect(
      probeMcpServer("https://169.254.169.254/latest/meta-data", undefined, { fetchFn }),
    ).rejects.toMatchObject({ status: 400 });
    expect(called).toBe(false);
  });

  it("sends the bearer token when provided", async () => {
    let sawAuth: string | null = null;
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const rpc = JSON.parse(requestBody(init)) as { method: string; id: number };
      sawAuth = new Headers(init?.headers).get("authorization");
      if (rpc.method === "initialize") return initializeResult(rpc.id);
      return toolsResult(rpc.id, 0);
    }) as typeof fetch;
    await probeMcpServer(SERVER_URL, "tok-1", { fetchFn });
    expect(sawAuth).toBe("Bearer tok-1");
  });
});

describe("discoverOAuthConfig", () => {
  it("discovers endpoints through protected resource metadata", async () => {
    const { fetchFn } = createOauthWorld();
    const config = await discoverOAuthConfig(
      SERVER_URL,
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      { fetchFn },
    );
    expect(config).toMatchObject({
      resource: SERVER_URL,
      issuer: "https://auth.example.com",
      authorizationEndpoint: "https://auth.example.com/authorize",
      tokenEndpoint: "https://auth.example.com/token",
      registrationEndpoint: "https://auth.example.com/register",
      scopes: ["mcp:tools"],
    });
  });

  it("falls back to well-known paths when no metadata URL is advertised", async () => {
    const { fetchFn } = createOauthWorld();
    const config = await discoverOAuthConfig(SERVER_URL, undefined, { fetchFn });
    expect(config.tokenEndpoint).toBe("https://auth.example.com/token");
  });

  it("throws oauth_discovery_failed when nothing is discoverable", async () => {
    const fetchFn = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    const error = await discoverOAuthConfig(SERVER_URL, undefined, { fetchFn }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).details?.code).toBe("oauth_discovery_failed");
  });

  it("rejects discovered endpoints that point at private networks", async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("oauth-protected-resource")) {
        return jsonResponse({ authorization_servers: ["https://auth.example.com"] });
      }
      if (url.includes("oauth-authorization-server")) {
        return jsonResponse({
          authorization_endpoint: "https://169.254.169.254/authorize",
          token_endpoint: "https://auth.example.com/token",
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    await expect(discoverOAuthConfig(SERVER_URL, undefined, { fetchFn })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("token exchange", () => {
  const auth = {
    tokenEndpoint: "https://auth.example.com/token",
    clientId: "client-abc",
    resource: SERVER_URL,
  };

  it("exchanges an authorization code with PKCE", async () => {
    const world = createOauthWorld();
    const tokens = await exchangeAuthorizationCode(
      auth,
      { code: "good-code", redirectUri: "https://app.example.com/cb", codeVerifier: "ver" },
      { fetchFn: world.fetchFn },
    );
    expect(tokens.accessToken).toBe(world.state.accessToken);
    expect(tokens.refreshToken).toBe(world.state.refreshToken);
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    const request = world.state.tokenRequests[0];
    expect(request.get("grant_type")).toBe("authorization_code");
    expect(request.get("code_verifier")).toBe("ver");
    expect(request.get("resource")).toBe(SERVER_URL);
  });

  it("surfaces only the OAuth error code on failure", async () => {
    const fetchFn = (async () =>
      jsonResponse(
        { error: "invalid_grant", error_description: "secret internals: token=abc123" },
        { status: 400 },
      )) as typeof fetch;
    const error = await exchangeAuthorizationCode(
      auth,
      { code: "bad", redirectUri: "https://app.example.com/cb", codeVerifier: "ver" },
      { fetchFn },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain("invalid_grant");
    expect((error as ApiError).message).not.toContain("abc123");
  });
});

describe("authorization URL", () => {
  it("builds a PKCE S256 authorization request", async () => {
    const pkce = await generatePkcePair();
    expect(pkce.verifier).not.toEqual(pkce.challenge);
    const url = new URL(
      buildAuthorizationUrl({
        authorizationEndpoint: "https://auth.example.com/authorize",
        clientId: "client-abc",
        redirectUri: "https://app.example.com/api/mcp/oauth/callback",
        state: "state-1",
        codeChallenge: pkce.challenge,
        resource: SERVER_URL,
        scopes: ["mcp:tools"],
      }),
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(url.searchParams.get("resource")).toBe(SERVER_URL);
    expect(url.searchParams.get("scope")).toBe("mcp:tools");
    expect(url.searchParams.get("state")).toBe("state-1");
  });
});
