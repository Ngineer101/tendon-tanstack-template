import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAuthorizationUrl,
  canonicalResource,
  createPkcePair,
  discoverOauthEndpoints,
  exchangeAuthorizationCode,
  parseWwwAuthenticate,
  type McpOauthConfig,
} from "./oauth.server";

const CONFIG: McpOauthConfig = {
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
  registrationEndpoint: "https://auth.example.com/register",
  scope: "mcp",
  resource: "https://mcp.example.com/mcp",
  clientId: "client-123",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetchRoutes(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    void init;
    const url = String(input).split("?")[0];
    const handler = routes[url];
    return handler ? handler() : new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseWwwAuthenticate", () => {
  it("extracts the resource metadata URL", () => {
    expect(
      parseWwwAuthenticate(
        'Bearer realm="mcp", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      ),
    ).toEqual({
      resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
    });
    expect(parseWwwAuthenticate('Bearer realm="mcp"')).toEqual({ resourceMetadataUrl: null });
    expect(parseWwwAuthenticate(null)).toEqual({ resourceMetadataUrl: null });
  });
});

describe("canonicalResource", () => {
  it("drops the root path and keeps deep paths", () => {
    expect(canonicalResource(new URL("https://mcp.example.com/"))).toBe("https://mcp.example.com");
    expect(canonicalResource(new URL("https://mcp.example.com/mcp"))).toBe(
      "https://mcp.example.com/mcp",
    );
  });
});

describe("discoverOauthEndpoints", () => {
  it("follows protected-resource metadata to the authorization server", async () => {
    stubFetchRoutes({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": () =>
        jsonResponse({
          resource: "https://mcp.example.com/mcp",
          authorization_servers: ["https://auth.example.com"],
          scopes_supported: ["mcp:tools", "mcp:read"],
        }),
      "https://auth.example.com/.well-known/oauth-authorization-server": () =>
        jsonResponse({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/oauth/authorize",
          token_endpoint: "https://auth.example.com/oauth/token",
          registration_endpoint: "https://auth.example.com/oauth/register",
        }),
    });

    const endpoints = await discoverOauthEndpoints(
      new URL("https://mcp.example.com/mcp"),
      null,
      {},
    );
    expect(endpoints).toEqual({
      authorizationEndpoint: "https://auth.example.com/oauth/authorize",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      registrationEndpoint: "https://auth.example.com/oauth/register",
      scope: "mcp:tools mcp:read",
      resource: "https://mcp.example.com/mcp",
    });
  });

  it("falls back to legacy default endpoints when no metadata is published", async () => {
    stubFetchRoutes({});

    const endpoints = await discoverOauthEndpoints(
      new URL("https://mcp.example.com/mcp"),
      null,
      {},
    );
    expect(endpoints).toEqual({
      authorizationEndpoint: "https://mcp.example.com/authorize",
      tokenEndpoint: "https://mcp.example.com/token",
      registrationEndpoint: "https://mcp.example.com/register",
      scope: null,
      resource: "https://mcp.example.com/mcp",
    });
  });

  it("rejects discovered endpoints that point at private hosts", async () => {
    stubFetchRoutes({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": () =>
        jsonResponse({
          resource: "https://mcp.example.com/mcp",
          authorization_servers: ["https://169.254.169.254"],
        }),
    });

    await expect(
      discoverOauthEndpoints(new URL("https://mcp.example.com/mcp"), null, {}),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("PKCE and authorization URL", () => {
  it("builds an S256 challenge from the verifier", async () => {
    const { verifier, challenge } = await createPkcePair();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const expected = Buffer.from(digest)
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });

  it("includes all OAuth 2.1 parameters", () => {
    const url = new URL(
      buildAuthorizationUrl(CONFIG, {
        redirectUri: "https://app.example.com/api/mcp/oauth/callback",
        state: "state-1",
        codeChallenge: "challenge-1",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-123",
      redirect_uri: "https://app.example.com/api/mcp/oauth/callback",
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
      resource: "https://mcp.example.com/mcp",
      scope: "mcp",
    });
  });
});

describe("exchangeAuthorizationCode", () => {
  it("sends the PKCE verifier and resource indicator", async () => {
    const fetchMock = stubFetchRoutes({
      "https://auth.example.com/token": () =>
        jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }),
    });

    const tokens = await exchangeAuthorizationCode(
      CONFIG,
      {
        code: "code-1",
        codeVerifier: "verifier-1",
        redirectUri: "https://app.example.com/api/mcp/oauth/callback",
        clientSecret: null,
      },
      {},
    );

    expect(tokens.accessToken).toBe("at-1");
    expect(tokens.refreshToken).toBe("rt-1");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());

    const init = fetchMock.mock.calls[0]?.[1];
    const body = new URLSearchParams(init?.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("resource")).toBe("https://mcp.example.com/mcp");
  });

  it("maps provider errors to a sanitized 502 without leaking the code", async () => {
    stubFetchRoutes({
      "https://auth.example.com/token": () =>
        jsonResponse({ error: "invalid_grant", error_description: "expired" }, 400),
    });

    const error = await exchangeAuthorizationCode(
      CONFIG,
      {
        code: "super-secret-code",
        codeVerifier: "verifier-1",
        redirectUri: "https://app.example.com/api/mcp/oauth/callback",
        clientSecret: null,
      },
      {},
    ).then(
      () => {
        throw new Error("expected the exchange to fail");
      },
      (reason: unknown) => reason as Error,
    );

    expect(error).toMatchObject({ status: 502 });
    expect(error.message).toContain("invalid_grant");
    expect(error.message).not.toContain("super-secret-code");
  });
});
