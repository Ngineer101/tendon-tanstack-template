import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAuthorizationUrl,
  deriveAuthorizationServerMetadataUrls,
  deriveProtectedResourceMetadataUrl,
  exchangeAuthorizationCode,
  generatePkceMaterial,
  isTokenExpired,
  parseWwwAuthenticate,
} from "./oauth.server";

describe("parseWwwAuthenticate", () => {
  it("extracts a quoted resource_metadata parameter", () => {
    expect(
      parseWwwAuthenticate(
        'Bearer realm="mcp", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      ),
    ).toEqual({ resourceMetadata: "https://mcp.example.com/.well-known/oauth-protected-resource" });
  });

  it("handles missing or malformed headers", () => {
    expect(parseWwwAuthenticate(null)).toEqual({});
    expect(parseWwwAuthenticate('Bearer realm="mcp"')).toEqual({});
    expect(parseWwwAuthenticate("")).toEqual({});
  });
});

describe("discovery URL derivation", () => {
  it("inserts the well-known suffix between host and path (RFC 9728)", () => {
    expect(deriveProtectedResourceMetadataUrl("https://mcp.example.com/mcp")).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );
    expect(deriveProtectedResourceMetadataUrl("https://mcp.example.com/")).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    );
  });

  it("builds RFC 8414 and OIDC candidates for issuers with paths", () => {
    expect(deriveAuthorizationServerMetadataUrls("https://auth.example.com/tenant")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant",
      "https://auth.example.com/.well-known/openid-configuration/tenant",
    ]);
  });
});

describe("generatePkceMaterial", () => {
  it("produces a valid S256 challenge for the verifier", async () => {
    const { verifier, challenge, state } = await generatePkceMaterial();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    const expected = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
    expect(state.length).toBeGreaterThanOrEqual(43);
  });

  it("generates unique values per call", async () => {
    const a = await generatePkceMaterial();
    const b = await generatePkceMaterial();
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("buildAuthorizationUrl", () => {
  it("includes PKCE, state and the RFC 8707 resource indicator", () => {
    const url = new URL(
      buildAuthorizationUrl(
        {
          issuer: "https://auth.example.com",
          authorizationEndpoint: "https://auth.example.com/authorize",
          tokenEndpoint: "https://auth.example.com/token",
          registrationEndpoint: null,
        },
        {
          clientId: "client-1",
          redirectUri: "https://app.example.com/api/mcp/oauth/callback",
          state: "state-1",
          codeChallenge: "challenge-1",
          resource: "https://mcp.example.com/mcp",
        },
      ),
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/api/mcp/oauth/callback",
    );
  });
});

describe("token endpoint error handling", () => {
  afterEach(() => vi.unstubAllGlobals());

  const metadata = {
    issuer: "https://auth.example.com",
    authorizationEndpoint: "https://auth.example.com/authorize",
    tokenEndpoint: "https://auth.example.com/token",
    registrationEndpoint: null,
  };

  it("maps invalid_grant to a reconnect-required error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );
    await expect(
      exchangeAuthorizationCode(
        metadata,
        { clientId: "c" },
        {
          code: "code",
          redirectUri: "https://app.example.com/cb",
          codeVerifier: "verifier",
          resource: "https://mcp.example.com/mcp",
        },
      ),
    ).rejects.toThrow(/expired/);
  });

  it("never leaks provider error descriptions (potential credentials) into errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "temporarily_unavailable",
              error_description: "token ak_live_123 leaked",
            }),
            { status: 503 },
          ),
      ),
    );
    const failure = await exchangeAuthorizationCode(
      metadata,
      { clientId: "c" },
      {
        code: "code",
        redirectUri: "https://app.example.com/cb",
        codeVerifier: "verifier",
        resource: "https://mcp.example.com/mcp",
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("ak_live_123");
  });
});

describe("isTokenExpired", () => {
  it("treats tokens without expiry as valid and applies skew", () => {
    expect(isTokenExpired({})).toBe(false);
    expect(isTokenExpired({ expiresAt: Date.now() + 10 * 60 * 1000 })).toBe(false);
    expect(isTokenExpired({ expiresAt: Date.now() + 30 * 1000 })).toBe(true);
    expect(isTokenExpired({ expiresAt: Date.now() - 1000 })).toBe(true);
  });
});
