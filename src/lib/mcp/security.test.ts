import { describe, expect, it } from "vitest";

import { ApiError } from "#/lib/api-error";
import {
  canonicalizeMcpServerUrl,
  parseWwwAuthenticateMetadata,
  parseWwwAuthenticateScope,
  safeRedirectTarget,
  validateExternalUrl,
} from "./security";

describe("MCP outbound URL policy", () => {
  it("accepts and canonicalizes public HTTPS endpoints", () => {
    expect(canonicalizeMcpServerUrl("https://mcp.example.net/mcp?ignored=true")).toBe(
      "https://mcp.example.net/mcp",
    );
  });

  it.each([
    "http://mcp.example.net/mcp",
    "https://localhost/mcp",
    "https://127.0.0.1/mcp",
    "https://10.10.0.1/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/mcp",
    "https://mcp.example.net:8443/mcp",
    "https://user:password@mcp.example.net/mcp",
    "https://single-label/mcp",
  ])("rejects unsafe SSRF target %s", (target) => {
    expect(() => validateExternalUrl(target)).toThrow(ApiError);
  });

  it("blocks cross-origin redirects", () => {
    expect(() =>
      safeRedirectTarget("https://evil.example.net/callback", "https://mcp.example.net"),
    ).toThrow("unsafe redirect");
  });

  it("extracts protected-resource metadata from a bearer challenge", () => {
    const challenge =
      'Bearer realm="mcp", resource_metadata="https://mcp.example.net/.well-known/oauth-protected-resource", scope="tools:read tools:write"';
    expect(parseWwwAuthenticateMetadata(challenge)).toBe(
      "https://mcp.example.net/.well-known/oauth-protected-resource",
    );
    expect(parseWwwAuthenticateScope(challenge)).toEqual(["tools:read", "tools:write"]);
  });
});
