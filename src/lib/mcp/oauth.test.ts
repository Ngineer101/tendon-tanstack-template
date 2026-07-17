import { describe, it, expect } from "vitest";
import { generateCodeVerifier, generateCodeChallenge, generateState } from "#/lib/mcp/oauth";

describe("generateCodeVerifier", () => {
  it("generates a string of at least 43 characters", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("generates only valid PKCE characters", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("generates unique values on each call", () => {
    const v1 = generateCodeVerifier();
    const v2 = generateCodeVerifier();
    expect(v1).not.toBe(v2);
  });
});

describe("generateCodeChallenge", () => {
  it("generates a base64url-encoded SHA-256 hash", async () => {
    const verifier = "test-verifier-1234567890123456789012345678901";
    const challenge = await generateCodeChallenge(verifier);
    expect(challenge).toBeTruthy();
    expect(challenge).not.toContain("+");
    expect(challenge).not.toContain("/");
    expect(challenge).not.toContain("=");
  });

  it("produces different challenges for different verifiers", async () => {
    const c1 = await generateCodeChallenge("verifier-one-1234567890123456789012345");
    const c2 = await generateCodeChallenge("verifier-two-1234567890123456789012345");
    expect(c1).not.toBe(c2);
  });
});

describe("generateState", () => {
  it("generates a non-empty base64url string", () => {
    const state = generateState();
    expect(state).toBeTruthy();
    expect(state.length).toBeGreaterThan(0);
    expect(state).not.toContain("+");
    expect(state).not.toContain("/");
  });
});
