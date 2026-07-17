import { describe, expect, it, vi } from "vitest";

import { ApiError } from "#/lib/api-error";
import {
  assertCanCreateMcpServer,
  assertMcpServerOwner,
  buildAuthorizationUrl,
  decryptJson,
  discoverOAuthMetadata,
  encryptJson,
  normalizeMcpServerUrl,
  tokenNeedsRefresh,
} from "./core.server";
import { selectTokenAuthMethod, type OAuthMetadata } from "./oauth.server";
import { readBoundedJson, safeOutboundFetch } from "./security.server";

const resolvePublicHostname = vi.fn(async () => ["203.0.114.10"]);

describe("MCP URL and outbound request security", () => {
  it("normalizes safe HTTPS URLs", () => {
    expect(normalizeMcpServerUrl("https://mcp.example.net/rpc#secret")).toBe(
      "https://mcp.example.net/rpc",
    );
  });

  it.each([
    "http://mcp.example.net",
    "https://127.0.0.1/mcp",
    "https://169.254.169.254/latest",
    "https://2130706433/mcp",
    "https://[::1]/mcp",
    "https://user:pass@mcp.example.net",
    "https://service.internal/mcp",
  ])("rejects unsafe target %s", (url) => {
    expect(() => normalizeMcpServerUrl(url)).toThrow(ApiError);
  });

  it("blocks hostnames that resolve to a private address before fetch", async () => {
    const fetcher = vi.fn();
    await expect(
      safeOutboundFetch(
        "https://mcp.example.net",
        {},
        {
          fetcher,
          resolveHostname: async () => ["10.0.0.8"],
        },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds metadata response bodies", async () => {
    const response = new Response(JSON.stringify({ value: "x" }), {
      headers: { "content-type": "application/json", "content-length": "70000" },
    });
    await expect(readBoundedJson(response)).rejects.toMatchObject({ status: 502 });
  });
});

describe("MCP OAuth discovery", () => {
  it("discovers protected-resource and authorization-server metadata", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://mcp.example.net/rpc") {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://mcp.example.net/.well-known/oauth-protected-resource/rpc"',
          },
        });
      }
      if (url.endsWith("/.well-known/oauth-protected-resource/rpc")) {
        return Response.json({
          resource: "https://mcp.example.net/rpc",
          authorization_servers: ["https://auth.example.net/tenant"],
          scopes_supported: ["mcp:tools"],
        });
      }
      if (url === "https://auth.example.net/.well-known/oauth-authorization-server/tenant") {
        return Response.json({
          issuer: "https://auth.example.net/tenant",
          authorization_endpoint: "https://auth.example.net/tenant/authorize",
          token_endpoint: "https://auth.example.net/tenant/token",
          code_challenge_methods_supported: ["S256"],
        });
      }
      return new Response(null, { status: 404 });
    });

    await expect(
      discoverOAuthMetadata("https://mcp.example.net/rpc", {
        fetcher,
        resolveHostname: resolvePublicHostname,
      }),
    ).resolves.toEqual({
      serverUrl: "https://mcp.example.net/rpc",
      metadata: {
        issuer: "https://auth.example.net/tenant",
        authorization_endpoint: "https://auth.example.net/tenant/authorize",
        token_endpoint: "https://auth.example.net/tenant/token",
        code_challenge_methods_supported: ["S256"],
        resource: "https://mcp.example.net/rpc",
        scopes_supported: ["mcp:tools"],
        token_endpoint_auth_methods_supported: undefined,
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://auth.example.net/.well-known/oauth-authorization-server/tenant",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("rejects discovery redirects", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302 }));
    await expect(
      discoverOAuthMetadata("https://mcp.example.net", {
        fetcher,
        resolveHostname: resolvePublicHostname,
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("MCP OAuth authorization", () => {
  it("builds a resource-bound PKCE URL without leaking the verifier", () => {
    const url = new URL(
      buildAuthorizationUrl({
        metadata: {
          issuer: "https://auth.example.net/",
          authorization_endpoint: "https://auth.example.net/oauth/authorize",
          token_endpoint: "https://auth.example.net/oauth/token",
          resource: "https://mcp.example.net/rpc",
        },
        clientId: "client_test",
        redirectUri: "https://app.example.net/api/mcp/auth/callback",
        state: "state_test",
        codeChallenge: "challenge_test",
        scopes: "mcp:tools",
      }),
    );

    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state_test");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe("https://mcp.example.net/rpc");
    expect(url.searchParams.has("code_verifier")).toBe(false);
  });

  it("uses only token authentication methods supported by the provider", () => {
    const metadata = {
      issuer: "https://auth.example.net/",
      authorization_endpoint: "https://auth.example.net/authorize",
      token_endpoint: "https://auth.example.net/token",
      resource: "https://mcp.example.net/",
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    } satisfies OAuthMetadata;

    expect(selectTokenAuthMethod(metadata, true)).toBe("client_secret_post");
    expect(() => selectTokenAuthMethod(metadata, false)).toThrow(ApiError);
  });
});

describe("MCP auth data encryption", () => {
  it("encrypts credentials with purpose-bound AES-GCM", async () => {
    const secret = "01234567890123456789012345678901";
    const encrypted = await encryptJson({ access_token: "token_secret" }, secret, "server:1");

    expect(encrypted).not.toContain("token_secret");
    await expect(
      decryptJson<{ access_token: string }>(encrypted, secret, "server:1"),
    ).resolves.toEqual({ access_token: "token_secret" });
    await expect(decryptJson(encrypted, secret, "server:2")).rejects.toMatchObject({ status: 500 });
  });
});

describe("MCP authorization, refresh, and limits", () => {
  it("hides servers owned by another user", () => {
    expect(() => assertMcpServerOwner({ userId: "user_a" }, "user_b")).toThrow(ApiError);
  });

  it("enforces the free plan three-server limit", () => {
    expect(() =>
      assertCanCreateMcpServer({ activeServerCount: 3, hasUnlimitedServers: false }),
    ).toThrow(ApiError);
    expect(() =>
      assertCanCreateMcpServer({ activeServerCount: 30, hasUnlimitedServers: true }),
    ).not.toThrow();
  });

  it("refreshes expiring tokens with a one-minute safety window", () => {
    const now = 10_000_000;
    expect(tokenNeedsRefresh({ obtained_at: now - 3_550_000, expires_in: 3_600 }, now)).toBe(true);
    expect(tokenNeedsRefresh({ obtained_at: now, expires_in: 3_600 }, now)).toBe(false);
  });
});
