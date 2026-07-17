import { describe, expect, it } from "vitest";

import { ApiError } from "#/lib/api-error";
import { buildAuthorizationUrl, generatePkce, sanitizeScopes } from "#/lib/mcp/oauth.server";

describe("generatePkce", () => {
  it("produces an S256 challenge with the expected shape", async () => {
    const pkce = await generatePkce();
    expect(pkce.method).toBe("S256");
    expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce.codeChallenge.length).toBeGreaterThanOrEqual(43);
    // challenge must be base64url, no padding
    expect(pkce.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces a fresh verifier each call", async () => {
    const a = await generatePkce();
    const b = await generatePkce();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe("buildAuthorizationUrl", () => {
  const base = "https://auth.example.com/authorize";

  it("sets all required OAuth/PKCE params", () => {
    const url = buildAuthorizationUrl(base, {
      clientId: "mcp-client",
      redirectUri: "https://app.example.com/api/mcp/oauth/callback",
      state: "state123",
      codeChallenge: "challenge",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(base);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("mcp-client");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("state123");
  });

  it("joins scopes with spaces when provided", () => {
    const url = buildAuthorizationUrl(base, {
      clientId: "mcp-client",
      redirectUri: "https://app.example.com/api/mcp/oauth/callback",
      state: "s",
      codeChallenge: "c",
      scopes: ["read", "write"],
    });
    expect(new URL(url).searchParams.get("scope")).toBe("read write");
  });

  it("strips a URL fragment from the endpoint", () => {
    const url = buildAuthorizationUrl(`${base}#frag`, {
      clientId: "c",
      redirectUri: "https://app.example.com/cb",
      state: "s",
      codeChallenge: "c",
    });
    expect(new URL(url).hash).toBe("");
  });

  it("rejects an endpoint that embeds credentials", () => {
    expect(() =>
      buildAuthorizationUrl("https://user:pass@auth.example.com/authorize", {
        clientId: "c",
        redirectUri: "https://app.example.com/cb",
        state: "s",
        codeChallenge: "c",
      }),
    ).toThrow(ApiError);
  });

  it("throws on missing endpoint", () => {
    expect(() =>
      buildAuthorizationUrl("", {
        clientId: "c",
        redirectUri: "https://app.example.com/cb",
        state: "s",
        codeChallenge: "c",
      }),
    ).toThrow(ApiError);
  });
});

describe("sanitizeScopes", () => {
  it("drops non-strings, empties, oversize, and weird characters", () => {
    expect(sanitizeScopes(["ok", 5, "", "x".repeat(200), "bad scope", "still-ok", null])).toEqual([
      "ok",
      "still-ok",
    ]);
  });

  it("caps the number of scopes", () => {
    const many = Array.from({ length: 40 }, (_, i) => `s${i}`);
    expect(sanitizeScopes(many).length).toBe(32);
  });

  it("returns [] for non-array input", () => {
    expect(sanitizeScopes(undefined)).toEqual([]);
    expect(sanitizeScopes("read")).toEqual([]);
  });
});
