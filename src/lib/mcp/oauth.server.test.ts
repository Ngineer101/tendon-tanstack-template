import { describe, expect, it } from "vitest";

import {
  buildAuthorizationUrl,
  exchangeCode,
  generatePkce,
  generateState,
  registerClient,
} from "./oauth.server";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const metadata = {
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
  registrationEndpoint: "https://auth.example.com/register",
};

async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

describe("generatePkce", () => {
  it("derives the S256 challenge from the verifier", async () => {
    const { verifier, challenge } = await generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(await sha256Base64Url(verifier));
    expect(challenge).not.toContain("+");
    expect(challenge).not.toContain("/");
  });

  it("generates unique values per call", async () => {
    const first = await generatePkce();
    const second = await generatePkce();
    expect(first.verifier).not.toEqual(second.verifier);
    expect(generateState()).not.toEqual(generateState());
  });
});

describe("buildAuthorizationUrl", () => {
  it("includes PKCE, state, and the RFC 8707 resource indicator", () => {
    const url = new URL(
      buildAuthorizationUrl(metadata, {
        clientId: "client-1",
        redirectUri: "https://app.example.com/api/mcp/oauth/callback",
        state: "state-1",
        codeChallenge: "challenge-1",
        resource: "https://mcp.example.com/mcp",
      }),
    );

    expect(url.origin + url.pathname).toBe(metadata.authorizationEndpoint);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/api/mcp/oauth/callback",
    );
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe("https://mcp.example.com/mcp");
  });
});

describe("registerClient", () => {
  it("posts a public-client registration and returns the client id", async () => {
    const seen: { body?: string } = {};
    const fetchImpl: FetchLike = async (_input, init) => {
      seen.body = init?.body as string;
      return new Response(JSON.stringify({ client_id: "registered-1" }), { status: 201 });
    };

    const registration = await registerClient(
      metadata.registrationEndpoint!,
      "https://app.example.com/api/mcp/oauth/callback",
      fetchImpl,
    );

    expect(registration).toEqual({ clientId: "registered-1", clientSecret: undefined });
    const body = JSON.parse(seen.body!);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.redirect_uris).toEqual(["https://app.example.com/api/mcp/oauth/callback"]);
  });

  it("keeps an issued client secret when one is returned", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ client_id: "c", client_secret: "s3cr3t" }), { status: 201 });
    const registration = await registerClient(
      metadata.registrationEndpoint!,
      "https://cb",
      fetchImpl,
    );
    expect(registration.clientSecret).toBe("s3cr3t");
  });

  it("throws a sanitized 502 when registration is rejected", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ error: "invalid_client_metadata" }), { status: 400 });
    await expect(
      registerClient(metadata.registrationEndpoint!, "https://cb", fetchImpl),
    ).rejects.toThrowError(
      expect.objectContaining({
        status: 502,
        message: "The MCP server's authorization server rejected dynamic client registration",
      }),
    );
  });
});

describe("exchangeCode", () => {
  const params = {
    code: "code-1",
    verifier: "verifier-1",
    clientId: "client-1",
    redirectUri: "https://app.example.com/api/mcp/oauth/callback",
    resource: "https://mcp.example.com/mcp",
  };

  it("exchanges the code and maps the token set", async () => {
    let seenBody = "";
    const fetchImpl: FetchLike = async (_input, init) => {
      seenBody = init?.body as string;
      return new Response(
        JSON.stringify({
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
          scope: "read",
          token_type: "Bearer",
        }),
        { status: 200 },
      );
    };

    const before = Date.now();
    const tokens = await exchangeCode(metadata.tokenEndpoint, params, fetchImpl);

    expect(tokens.accessToken).toBe("at-1");
    expect(tokens.refreshToken).toBe("rt-1");
    expect(tokens.scope).toBe("read");
    expect(tokens.tokenType).toBe("Bearer");
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000);

    const sent = new URLSearchParams(seenBody);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code_verifier")).toBe("verifier-1");
    expect(sent.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(sent.has("client_secret")).toBe(false);
  });

  it("propagates only the standard error code, never the response body", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "code abc123secret was already used by client xyz",
        }),
        { status: 400 },
      );

    const error = await exchangeCode(metadata.tokenEndpoint, params, fetchImpl).catch(
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ status: 502 });
    expect((error as Error).message).toBe("Token exchange failed (invalid_grant)");
    expect((error as Error).message).not.toContain("abc123secret");
  });

  it("throws a sanitized 502 on network failure", async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error("socket hangup token=at-1"));
    await expect(exchangeCode(metadata.tokenEndpoint, params, fetchImpl)).rejects.toThrowError(
      expect.objectContaining({
        status: 502,
        message: "Unable to reach the authorization server's token endpoint",
      }),
    );
  });

  it("rejects malformed success responses", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 });
    await expect(exchangeCode(metadata.tokenEndpoint, params, fetchImpl)).rejects.toThrowError(
      expect.objectContaining({ status: 502 }),
    );
  });
});
