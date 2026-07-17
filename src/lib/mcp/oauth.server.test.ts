import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "#/lib/api-error";
import {
  buildAuthorizationUrl,
  computeCodeChallenge,
  discoverOAuth,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  parseWwwAuthenticate,
  registerOAuthClient,
  type AuthorizationServerMetadata,
} from "./oauth.server";

const AS_METADATA: AuthorizationServerMetadata = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  registration_endpoint: "https://auth.example.com/register",
  code_challenge_methods_supported: ["S256"],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseWwwAuthenticate", () => {
  it("extracts the resource metadata URL", () => {
    expect(
      parseWwwAuthenticate(
        'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      ).resourceMetadataUrl,
    ).toBe("https://mcp.example.com/.well-known/oauth-protected-resource");
  });

  it("handles absent headers", () => {
    expect(parseWwwAuthenticate(null).resourceMetadataUrl).toBeUndefined();
    expect(parseWwwAuthenticate("Bearer realm=x").resourceMetadataUrl).toBeUndefined();
  });
});

describe("discoverOAuth", () => {
  it("uses protected-resource metadata to find the authorization server", async () => {
    const documents: Record<string, unknown> = {
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": {
        resource: "https://mcp.example.com/mcp",
        authorization_servers: ["https://auth.example.com"],
        scopes_supported: ["mcp:read", "mcp:write"],
      },
      "https://auth.example.com/.well-known/oauth-authorization-server": AS_METADATA,
    };
    const discovery = await discoverOAuth("https://mcp.example.com/mcp", null, (url) =>
      Promise.resolve((documents[url] as Record<string, unknown>) ?? null),
    );
    expect(discovery.resource).toBe("https://mcp.example.com/mcp");
    expect(discovery.scopes).toEqual(["mcp:read", "mcp:write"]);
    expect(discovery.authServer.token_endpoint).toBe("https://auth.example.com/token");
  });

  it("falls back to the server origin when no resource metadata exists", async () => {
    const documents: Record<string, unknown> = {
      "https://mcp.example.com/.well-known/oauth-authorization-server": {
        issuer: "https://mcp.example.com",
        authorization_endpoint: "https://mcp.example.com/authorize",
        token_endpoint: "https://mcp.example.com/token",
      },
    };
    const discovery = await discoverOAuth("https://mcp.example.com/mcp", null, (url) =>
      Promise.resolve((documents[url] as Record<string, unknown>) ?? null),
    );
    expect(discovery.authServer.issuer).toBe("https://mcp.example.com");
  });

  it("rejects discovered endpoints that point at private hosts", async () => {
    const documents: Record<string, unknown> = {
      "https://mcp.example.com/.well-known/oauth-authorization-server": {
        issuer: "https://mcp.example.com",
        authorization_endpoint: "https://mcp.example.com/authorize",
        token_endpoint: "https://169.254.169.254/token",
      },
    };
    await expect(
      discoverOAuth("https://mcp.example.com/mcp", null, (url) =>
        Promise.resolve((documents[url] as Record<string, unknown>) ?? null),
      ),
    ).rejects.toThrow(ApiError);
  });

  it("throws a clear error when nothing is discoverable", async () => {
    await expect(
      discoverOAuth("https://mcp.example.com/mcp", null, () => Promise.resolve(null)),
    ).rejects.toMatchObject({ status: 422, details: { code: "oauth_discovery_failed" } });
  });
});

describe("PKCE", () => {
  it("computes the RFC 7636 reference challenge", async () => {
    await expect(computeCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("generates unique url-safe verifiers", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateCodeVerifier()).not.toBe(verifier);
  });
});

describe("buildAuthorizationUrl", () => {
  it("includes every required OAuth 2.1 parameter", () => {
    const url = new URL(
      buildAuthorizationUrl(AS_METADATA, {
        clientId: "client-1",
        redirectUri: "https://app.example.com/api/mcp/oauth/callback",
        state: "state-token",
        codeChallenge: "challenge",
        resource: "https://mcp.example.com/mcp",
        scope: "mcp:read",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("state")).toBe("state-token");
    expect(url.searchParams.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(url.searchParams.get("scope")).toBe("mcp:read");
  });

  it("refuses authorization servers without S256 support", () => {
    expect(() =>
      buildAuthorizationUrl(
        { ...AS_METADATA, code_challenge_methods_supported: ["plain"] },
        {
          clientId: "client-1",
          redirectUri: "https://app.example.com/cb",
          state: "s",
          codeChallenge: "c",
          resource: "https://mcp.example.com/mcp",
        },
      ),
    ).toThrow("PKCE");
  });
});

describe("token requests", () => {
  it("exchanges an authorization code and never leaks the raw error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            { error: "invalid_grant", secret_debug: "leaky-internals" },
            { status: 400 },
          ),
        ),
      ),
    );
    await expect(
      exchangeAuthorizationCode(AS_METADATA, {
        client: { clientId: "client-1" },
        code: "code",
        codeVerifier: "verifier",
        redirectUri: "https://app.example.com/cb",
        resource: "https://mcp.example.com/mcp",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).message).toContain("invalid_grant");
      expect((error as ApiError).message).not.toContain("leaky-internals");
      return true;
    });
  });

  it("sends form-encoded credentials to the token endpoint", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json({ access_token: "token-123", expires_in: 3600 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tokens = await exchangeAuthorizationCode(AS_METADATA, {
      client: { clientId: "client-1", clientSecret: "shh" },
      code: "code-1",
      codeVerifier: "verifier-1",
      redirectUri: "https://app.example.com/cb",
      resource: "https://mcp.example.com/mcp",
    });
    expect(tokens.access_token).toBe("token-123");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.example.com/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("client_secret")).toBe("shh");
    expect(body.get("resource")).toBe("https://mcp.example.com/mcp");
  });
});

describe("registerOAuthClient", () => {
  it("registers a public client via RFC 7591", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json({ client_id: "generated-client" }, { status: 201 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = await registerOAuthClient(AS_METADATA, {
      redirectUri: "https://app.example.com/cb",
      clientName: "Test App",
    });
    expect(client).toEqual({ clientId: "generated-client", clientSecret: undefined });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload.redirect_uris).toEqual(["https://app.example.com/cb"]);
    expect(payload.token_endpoint_auth_method).toBe("none");
  });

  it("fails clearly when registration is not supported", async () => {
    await expect(
      registerOAuthClient(
        { ...AS_METADATA, registration_endpoint: undefined },
        { redirectUri: "https://app.example.com/cb", clientName: "Test App" },
      ),
    ).rejects.toMatchObject({ status: 422, details: { code: "oauth_registration_unsupported" } });
  });
});
