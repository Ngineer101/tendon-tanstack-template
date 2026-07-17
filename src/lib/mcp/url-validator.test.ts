import { describe, it, expect } from "vitest";
import { validateServerUrl, validateRedirectUrl } from "#/lib/mcp/url-validator";

describe("validateServerUrl", () => {
  it("accepts valid HTTPS URLs", () => {
    const result = validateServerUrl("https://mcp.example.com");
    expect(result.valid).toBe(true);
    expect(result.normalizedUrl).toBe("https://mcp.example.com");
  });

  it("strips trailing path, query, and hash from valid URLs", () => {
    const result = validateServerUrl("https://mcp.example.com/api/v1?foo=bar#section");
    expect(result.valid).toBe(true);
    expect(result.normalizedUrl).toBe("https://mcp.example.com");
  });

  it("rejects HTTP URLs", () => {
    const result = validateServerUrl("http://mcp.example.com");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("HTTPS");
  });

  it("rejects empty input", () => {
    const result = validateServerUrl("");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("URL is required");
  });

  it("rejects invalid URL format", () => {
    const result = validateServerUrl("not-a-url");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid URL format");
  });

  it("rejects localhost", () => {
    const result = validateServerUrl("https://localhost:8080");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("local or private");
  });

  it("rejects 127.0.0.1", () => {
    const result = validateServerUrl("https://127.0.0.1:3000");
    expect(result.valid).toBe(false);
  });

  it("rejects private network 10.x.x.x", () => {
    const result = validateServerUrl("https://10.0.0.1");
    expect(result.valid).toBe(false);
  });

  it("rejects private network 192.168.x.x", () => {
    const result = validateServerUrl("https://192.168.1.1");
    expect(result.valid).toBe(false);
  });

  it("rejects private network 172.16.x.x", () => {
    const result = validateServerUrl("https://172.16.0.1");
    expect(result.valid).toBe(false);
  });

  it("rejects IPv6 loopback", () => {
    const result = validateServerUrl("https://[::1]");
    expect(result.valid).toBe(false);
  });

  it("rejects URLs with credentials", () => {
    const result = validateServerUrl("https://user:pass@mcp.example.com");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("credentials");
  });

  it("accepts subdomain URLs", () => {
    const result = validateServerUrl("https://api.mcp.example.com");
    expect(result.valid).toBe(true);
  });
});

describe("validateRedirectUrl", () => {
  it("accepts redirects to the same origin", () => {
    expect(validateRedirectUrl("https://mcp.example.com", "https://mcp.example.com/callback")).toBe(
      true,
    );
  });

  it("rejects redirects to a different origin", () => {
    expect(validateRedirectUrl("https://mcp.example.com", "https://evil.com/callback")).toBe(false);
  });

  it("rejects invalid redirect URLs", () => {
    expect(validateRedirectUrl("https://mcp.example.com", "not-a-url")).toBe(false);
  });
});
