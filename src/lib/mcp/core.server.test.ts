import { describe, expect, it, vi } from "vitest";

import { ApiError } from "#/lib/api-error";
import {
  assertCanConnectMcpServer,
  assertMcpConnectionOwner,
  decryptJson,
  discoverMcpOAuth,
  encryptJson,
  normalizeMcpServerUrl,
} from "./core.server";

function requestUrl(input: RequestInfo | URL) {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

describe("MCP server URL safety", () => {
  it("normalizes public HTTPS server URLs", () => {
    expect(normalizeMcpServerUrl("https://mcp.example.com/sse#ignored")).toBe(
      "https://mcp.example.com/sse",
    );
  });

  it("rejects unsafe outbound URLs", () => {
    const unsafeUrls = [
      "http://mcp.example.com",
      "https://localhost/sse",
      "https://127.0.0.1/sse",
      "https://10.0.0.2/sse",
      "https://user:pass@mcp.example.com/sse",
      "https://metadata.google.internal/sse",
      "https://2130706433/sse",
      "https://[::1]/sse",
      "https://mcp.example.com@127.0.0.1/sse",
    ];

    for (const url of unsafeUrls) {
      expect(() => normalizeMcpServerUrl(url), url).toThrow(ApiError);
    }
  });
});

describe("MCP entitlement limits", () => {
  it("enforces the free plan three-server limit", () => {
    expect(() => assertCanConnectMcpServer({ plan: "free", activeServerCount: 2 })).not.toThrow();

    expect(() => assertCanConnectMcpServer({ plan: "free", activeServerCount: 3 })).toThrowError(
      /up to 3 MCP servers/,
    );
  });

  it("allows paid plans and active reconnections beyond the free limit", () => {
    expect(() =>
      assertCanConnectMcpServer({ plan: "pro_monthly", activeServerCount: 12 }),
    ).not.toThrow();
    expect(() =>
      assertCanConnectMcpServer({
        plan: "free",
        activeServerCount: 3,
        existingStatus: "connected",
      }),
    ).not.toThrow();
  });

  it("requires a free slot when reconnecting a disconnected server", () => {
    expect(() =>
      assertCanConnectMcpServer({
        plan: "free",
        activeServerCount: 3,
        existingStatus: "disconnected",
      }),
    ).toThrowError(/up to 3 MCP servers/);
  });
});

describe("MCP authorization checks", () => {
  it("does not reveal whether another user's connection exists", () => {
    expect(() => assertMcpConnectionOwner(undefined, "user_1")).toThrowError(/not found/);
    expect(() => assertMcpConnectionOwner({ userId: "user_2" }, "user_1")).toThrowError(
      /not found/,
    );
  });
});

describe("MCP auth encryption", () => {
  it("round-trips auth data without storing plaintext tokens", async () => {
    const secret = "test-secret-with-at-least-thirty-two-characters";
    const encrypted = await encryptJson(secret, {
      accessToken: "access_token_secret",
      refreshToken: "refresh_token_secret",
    });

    expect(encrypted).not.toContain("access_token_secret");
    expect(encrypted).not.toContain("refresh_token_secret");

    await expect(
      decryptJson<{ accessToken: string; refreshToken: string }>(secret, encrypted),
    ).resolves.toEqual({
      accessToken: "access_token_secret",
      refreshToken: "refresh_token_secret",
    });
  });

  it("requires a configured encryption secret", async () => {
    await expect(encryptJson("short", { accessToken: "secret" })).rejects.toThrow(
      /encryption is not configured/,
    );
  });

  it("rejects tampered ciphertext", async () => {
    const secret = "test-secret-with-at-least-thirty-two-characters";
    const encrypted = await encryptJson(secret, { accessToken: "secret" });
    const envelope = JSON.parse(encrypted) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}aa`;

    await expect(decryptJson(secret, JSON.stringify(envelope))).rejects.toThrow();
  });
});

describe("MCP OAuth discovery", () => {
  it("refuses discovery redirects", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302 }));

    await expect(discoverMcpOAuth("https://mcp.example.com/sse", fetcher)).rejects.toThrow(
      /redirects are not followed/i,
    );
  });

  it("discovers OAuth metadata from a WWW-Authenticate resource metadata challenge", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://mcp.example.com/sse") {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          },
        });
      }
      if (url === "https://mcp.example.com/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: "https://mcp.example.com/sse",
          authorization_servers: ["https://auth.example.com"],
          scopes_supported: ["tools:read"],
        });
      }
      if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
          scopes_supported: ["openid", "profile"],
        });
      }
      return new Response(null, { status: 404 });
    });

    await expect(discoverMcpOAuth("https://mcp.example.com/sse", fetcher)).resolves.toMatchObject({
      issuer: "https://auth.example.com/",
      authorizationEndpoint: "https://auth.example.com/authorize",
      tokenEndpoint: "https://auth.example.com/token",
      registrationEndpoint: "https://auth.example.com/register",
      scopesSupported: ["tools:read", "openid", "profile"],
      resource: "https://mcp.example.com/sse",
    });
  });

  it("uses path-specific protected resource metadata", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "https://mcp.example.com/team/mcp") {
        return new Response(null, { status: 401 });
      }
      if (url === "https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp") {
        return Response.json({
          resource: "https://mcp.example.com/team/mcp",
          authorization_servers: ["https://identity.example.com/tenant"],
          scopes_supported: ["tools:read"],
        });
      }
      if (url === "https://identity.example.com/.well-known/oauth-authorization-server/tenant") {
        return Response.json({
          issuer: "https://identity.example.com/tenant",
          authorization_endpoint: "https://identity.example.com/tenant/authorize",
          token_endpoint: "https://identity.example.com/tenant/token",
        });
      }
      return new Response(null, { status: 404 });
    });

    await expect(
      discoverMcpOAuth("https://mcp.example.com/team/mcp", fetcher),
    ).resolves.toMatchObject({
      issuer: "https://identity.example.com/tenant",
      resource: "https://mcp.example.com/team/mcp",
      scopesSupported: ["tools:read"],
    });
  });

  it("rejects protected resource metadata for a different origin", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "https://mcp.example.com/mcp") return new Response(null, { status: 401 });
      if (url.includes("oauth-protected-resource")) {
        return Response.json({
          resource: "https://attacker.example/mcp",
          authorization_servers: ["https://auth.example.com"],
        });
      }
      return new Response(null, { status: 404 });
    });

    await expect(discoverMcpOAuth("https://mcp.example.com/mcp", fetcher)).rejects.toThrow(
      /does not match the configured server/,
    );
  });
});
