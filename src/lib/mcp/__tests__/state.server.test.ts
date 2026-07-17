import { describe, expect, it } from "vitest";

import { ApiError } from "#/lib/api-error";
import { createStateToken, deriveStateKey, verifyStateToken } from "#/lib/mcp/state.server";

const SECRET = "test-secret-do-not-use-in-prod";

describe("MCP OAuth state", () => {
  it("round-trips a signed state", async () => {
    const key = await deriveStateKey(SECRET);
    const token = await createStateToken(key, {
      serverId: "mcp_1",
      userId: "u_1",
      codeVerifier: "verifier",
    });
    const state = await verifyStateToken(key, token);
    expect(state.serverId).toBe("mcp_1");
    expect(state.userId).toBe("u_1");
    expect(state.codeVerifier).toBe("verifier");
    expect(typeof state.expiresAt).toBe("number");
  });

  it("rejects a tampered signature", async () => {
    const key = await deriveStateKey(SECRET);
    const token = await createStateToken(key, {
      serverId: "mcp_1",
      userId: "u_1",
      codeVerifier: "v",
    });
    const [payload, sig] = token.split(".");
    const flipped = sig.slice(0, -1) + (sig.slice(-1) === "a" ? "b" : "a");
    await expect(verifyStateToken(key, `${payload}.${flipped}`)).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects a state signed with a different key", async () => {
    const a = await deriveStateKey("key-a");
    const b = await deriveStateKey("key-b");
    const token = await createStateToken(a, {
      serverId: "mcp_1",
      userId: "u_1",
      codeVerifier: "v",
    });
    await expect(verifyStateToken(b, token)).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects expired state", async () => {
    const key = await deriveStateKey(SECRET);
    const issued = await createStateToken(key, {
      serverId: "mcp_1",
      userId: "u_1",
      codeVerifier: "v",
    });
    // The token encodes expiresAt = now + ttl; verify with now far in the future.
    const [payload, sig] = issued.split(".");
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
          c.charCodeAt(0),
        ),
      ),
    );
    decoded.expiresAt = Date.now() - 1000;
    const expiredPayload = btoa(JSON.stringify(decoded))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await expect(verifyStateToken(key, `${expiredPayload}.${sig}`)).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("rejects a malformed token", async () => {
    const key = await deriveStateKey(SECRET);
    await expect(verifyStateToken(key, "no-dot")).rejects.toBeInstanceOf(ApiError);
    await expect(verifyStateToken(key, "payload.nonhex")).rejects.toBeInstanceOf(ApiError);
  });
});
