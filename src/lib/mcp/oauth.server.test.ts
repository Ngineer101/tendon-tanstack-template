// Tests for the MCP OAuth discovery + PKCE flow. The network layer is mocked
// via the global `fetch` so these tests assert request shape and response
// handling without real I/O.
//
// Covered:
// - PKCE verifier/challenge generation
// - authorization URL construction (params, scope default)
// - OAuth metadata discovery success + error cases (404, incomplete, bad JSON)
// - authorization endpoint validation against SSRF rules
// - token exchange success + malformed response handling

import { describe, expect, it, vi, beforeEach } from "vitest";

import { ApiError } from "#/lib/api-error";
import type { McpEnv } from "#/lib/mcp/config.server";
import {
  buildAuthorizationUrl,
  codeVerifierToChallenge,
  discoverOAuthMetadata,
  exchangeCode,
  randomBase64Url,
} from "#/lib/mcp/oauth.server";

function env(overrides: Partial<McpEnv> = {}): McpEnv {
  return {
    DB: {} as D1Database,
    BETTER_AUTH_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: "secret",
    MCP_ENCRYPTION_KEY: "key",
    ...overrides,
  } as unknown as McpEnv;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({})),
  );
});

describe("PKCE helpers", () => {
  it("generates a high-entropy base64url verifier", () => {
    const v = randomBase64Url(32);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → ~43 base64url chars.
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
  });

  it("computes an S256 challenge that differs from the verifier", async () => {
    const verifier = randomBase64Url(32);
    const challenge = await codeVerifierToChallenge(verifier);
    expect(challenge).not.toBe(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("buildAuthorizationUrl", () => {
  const metadata = {
    authorizationEndpoint: "https://mcp.example.com/authorize",
    tokenEndpoint: "https://mcp.example.com/token",
  };

  it("builds a URL with PKCE S256 + state + redirect_uri", async () => {
    const url = await buildAuthorizationUrl({
      codeVerifier: "verifier-value",
      state: "state-value",
      metadata,
      redirectUri: "http://localhost:3000/api/mcp/oauth/callback",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://mcp.example.com/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("state-value");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/mcp/oauth/callback",
    );
    // Default scope is applied.
    expect(parsed.searchParams.get("scope")).toBe("mcp");
    // The challenge is not the raw verifier (S256).
    expect(parsed.searchParams.get("code_challenge")).not.toBe("verifier-value");
  });
});

describe("discoverOAuthMetadata", () => {
  it("parses a valid metadata document", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        authorization_endpoint: "https://mcp.example.com/authorize",
        token_endpoint: "https://mcp.example.com/token",
        registration_endpoint: "https://mcp.example.com/register",
        scopes_supported: ["mcp"],
      }),
    );
    const meta = await discoverOAuthMetadata(
      env(),
      "https://mcp.example.com/",
      "http://localhost:3000",
    );
    expect(meta.authorizationEndpoint).toBe("https://mcp.example.com/authorize");
    expect(meta.tokenEndpoint).toBe("https://mcp.example.com/token");
    expect(meta.registrationEndpoint).toBe("https://mcp.example.com/register");
    expect(meta.scopesSupported).toEqual(["mcp"]);
  });

  it("throws a 424 when the server has no metadata document (404)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(
      discoverOAuthMetadata(env(), "https://mcp.example.com/", "http://localhost:3000"),
    ).rejects.toMatchObject({ status: 424 });
  });

  it("throws a 502 when the metadata document is not JSON", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    await expect(
      discoverOAuthMetadata(env(), "https://mcp.example.com/", "http://localhost:3000"),
    ).rejects.toMatchObject({ name: "ApiError" });
  });

  it("throws a 424 when metadata is missing required endpoints", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ authorization_endpoint: "https://mcp.example.com/authorize" }),
    );
    await expect(
      discoverOAuthMetadata(env(), "https://mcp.example.com/", "http://localhost:3000"),
    ).rejects.toMatchObject({ status: 424 });
  });

  it("rejects metadata whose endpoints point at private IPs (SSRF on redirect target)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        authorization_endpoint: "https://169.254.169.254/authorize",
        token_endpoint: "https://mcp.example.com/token",
      }),
    );
    await expect(
      discoverOAuthMetadata(env(), "https://mcp.example.com/", "http://localhost:3000"),
    ).rejects.toThrow(ApiError);
  });
});

describe("exchangeCode", () => {
  it("exchanges a code for a StoredAuth with computed expiry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        access_token: "the-token",
        refresh_token: "the-refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "mcp",
      }),
    );
    const auth = await exchangeCode(env(), {
      metadata: {
        authorizationEndpoint: "https://mcp.example.com/authorize",
        tokenEndpoint: "https://mcp.example.com/token",
      },
      redirectUri: "http://localhost:3000/api/mcp/oauth/callback",
      auth: { clientId: "client-1" },
      code: "the-code",
      codeVerifier: "the-verifier",
      appOrigin: "http://localhost:3000",
    });
    expect(auth.accessToken).toBe("the-token");
    expect(auth.refreshToken).toBe("the-refresh");
    expect(auth.tokenType).toBe("Bearer");
    expect(auth.scope).toBe("mcp");
    expect(auth.expiresAt).toBeGreaterThan(Date.now());

    // Verify the request body contained the PKCE verifier (S256 flow).
    const call = vi.mocked(fetch).mock.calls[0];
    const init = call?.[1] as RequestInit;
    const body = init.body as string;
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=the-code");
    expect(body).toContain("code_verifier=the-verifier");
    expect(body).toContain("client_id=client-1");
  });

  it("throws a 502 when the token endpoint rejects the code", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(
      exchangeCode(env(), {
        metadata: {
          authorizationEndpoint: "https://mcp.example.com/authorize",
          tokenEndpoint: "https://mcp.example.com/token",
        },
        redirectUri: "http://localhost:3000/api/mcp/oauth/callback",
        auth: {},
        code: "bad",
        codeVerifier: "v",
        appOrigin: "http://localhost:3000",
      }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("throws a 502 when the response is missing an access token", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "x" }));
    await expect(
      exchangeCode(env(), {
        metadata: {
          authorizationEndpoint: "https://mcp.example.com/authorize",
          tokenEndpoint: "https://mcp.example.com/token",
        },
        redirectUri: "http://localhost:3000/api/mcp/oauth/callback",
        auth: {},
        code: "x",
        codeVerifier: "v",
        appOrigin: "http://localhost:3000",
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
});
