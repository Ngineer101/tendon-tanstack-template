import { describe, expect, it, vi } from "vitest";

import { ApiError } from "#/lib/api-error";
import {
  assertCanCreateMcpServer,
  assertMcpServerOwner,
  buildAuthorizationUrl,
  discoverOAuthMetadata,
  encryptJson,
  decryptJson,
  normalizeMcpServerUrl,
} from "./core.server";

describe("MCP URL validation", () => {
  it("normalizes safe HTTPS URLs", () => {
    expect(normalizeMcpServerUrl("https://mcp.example.com/rpc#secret")).toBe(
      "https://mcp.example.com/rpc",
    );
  });

  it("rejects unsafe SSRF targets", () => {
    expect(() => normalizeMcpServerUrl("http://mcp.example.com")).toThrow(ApiError);
    expect(() => normalizeMcpServerUrl("https://127.0.0.1/mcp")).toThrow(ApiError);
    expect(() => normalizeMcpServerUrl("https://169.254.169.254/latest")).toThrow(ApiError);
    expect(() => normalizeMcpServerUrl("https://user:pass@mcp.example.com")).toThrow(ApiError);
  });
});

describe("MCP OAuth discovery", () => {
  it("accepts valid authorization server metadata", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/oauth/authorize",
        token_endpoint: "https://auth.example.com/oauth/token",
        scopes_supported: ["mcp:tools"],
      }),
    );

    await expect(discoverOAuthMetadata("https://mcp.example.com", fetcher)).resolves.toEqual({
      serverUrl: "https://mcp.example.com/",
      metadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/oauth/authorize",
        token_endpoint: "https://auth.example.com/oauth/token",
        scopes_supported: ["mcp:tools"],
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://mcp.example.com/.well-known/oauth-authorization-server",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("turns discovery redirects into API errors", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302 }));

    await expect(discoverOAuthMetadata("https://mcp.example.com", fetcher)).rejects.toMatchObject({
      status: 502,
    });
  });
});

describe("MCP OAuth authorization", () => {
  it("builds a PKCE authorization URL without leaking the verifier", () => {
    const url = new URL(
      buildAuthorizationUrl({
        metadata: {
          authorization_endpoint: "https://auth.example.com/oauth/authorize",
          token_endpoint: "https://auth.example.com/oauth/token",
        },
        clientId: "client_test",
        redirectUri: "https://app.example.com/api/mcp/auth/callback",
        state: "state_test",
        codeChallenge: "challenge_test",
        scopes: "mcp:tools",
      }),
    );

    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client_test");
    expect(url.searchParams.get("state")).toBe("state_test");
    expect(url.searchParams.get("code_challenge")).toBe("challenge_test");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("code_verifier")).toBe(false);
  });
});

describe("MCP auth data encryption", () => {
  it("encrypts token data before storage and decrypts it with the same key", async () => {
    const secret = "01234567890123456789012345678901";
    const encrypted = await encryptJson({ access_token: "token_secret" }, secret);

    expect(encrypted).not.toContain("token_secret");
    await expect(decryptJson<{ access_token: string }>(encrypted, secret)).resolves.toEqual({
      access_token: "token_secret",
    });
  });
});

describe("MCP authorization and limits", () => {
  it("hides servers owned by another user", () => {
    expect(() => assertMcpServerOwner({ userId: "user_a" }, "user_b")).toThrow(ApiError);
  });

  it("enforces the free plan three-server limit server-side", () => {
    expect(() =>
      assertCanCreateMcpServer({ activeServerCount: 3, hasUnlimitedServers: false }),
    ).toThrow(ApiError);
    expect(() =>
      assertCanCreateMcpServer({ activeServerCount: 30, hasUnlimitedServers: true }),
    ).not.toThrow();
  });
});
