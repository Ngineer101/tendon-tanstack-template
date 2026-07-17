import { describe, expect, it } from "vitest";

import { ApiError } from "#/lib/api-error";
import { assertSafeRedirectTarget, validateMcpServerUrl } from "./url";

describe("validateMcpServerUrl", () => {
  it("accepts a public HTTPS URL and normalizes it", () => {
    const result = validateMcpServerUrl("https://mcp.example.com/mcp/");
    expect(result.normalized).toBe("https://mcp.example.com/mcp");
    expect(result.host).toBe("mcp.example.com");
  });

  it("keeps query strings but strips fragments", () => {
    const result = validateMcpServerUrl("https://mcp.example.com/mcp?team=1#secret");
    expect(result.normalized).toBe("https://mcp.example.com/mcp?team=1");
  });

  it("rejects unparseable URLs", () => {
    expect(() => validateMcpServerUrl("not a url")).toThrow(ApiError);
    expect(() => validateMcpServerUrl("")).toThrow(ApiError);
  });

  it("rejects non-HTTP schemes", () => {
    for (const raw of ["ftp://example.com/mcp", "file:///etc/passwd", "ws://example.com/mcp"]) {
      expect(() => validateMcpServerUrl(raw)).toThrow(/HTTPS/);
    }
  });

  it("rejects plain HTTP for public hosts", () => {
    expect(() => validateMcpServerUrl("http://mcp.example.com/mcp")).toThrow(/HTTPS/);
  });

  it("allows HTTP for loopback hosts (local development)", () => {
    expect(validateMcpServerUrl("http://localhost:3001/mcp").host).toBe("localhost:3001");
    expect(validateMcpServerUrl("http://127.0.0.1:8080/mcp").host).toBe("127.0.0.1:8080");
    expect(validateMcpServerUrl("http://[::1]:8080/mcp").host).toBe("[::1]:8080");
  });

  it("rejects URLs with embedded credentials", () => {
    expect(() => validateMcpServerUrl("https://user:pass@mcp.example.com/mcp")).toThrow(
      /credentials/,
    );
  });

  it("rejects private IPv4 literals (SSRF)", () => {
    const blocked = [
      "https://10.0.0.5/mcp",
      "https://172.16.0.1/mcp",
      "https://172.31.255.255/mcp",
      "https://192.168.1.1/mcp",
      "https://169.254.169.254/latest/meta-data",
      "https://0.0.0.0/mcp",
      "https://100.64.0.1/mcp",
      "https://224.0.0.1/mcp",
    ];
    for (const raw of blocked) {
      expect(() => validateMcpServerUrl(raw), raw).toThrow(/Private/);
    }
  });

  it("rejects private IPv6 literals (SSRF)", () => {
    expect(() => validateMcpServerUrl("https://[fd00::1]/mcp")).toThrow(/Private/);
    expect(() => validateMcpServerUrl("https://[fe80::1]/mcp")).toThrow(/Private/);
    expect(() => validateMcpServerUrl("https://[::ffff:192.168.0.1]/mcp")).toThrow(/Private/);
  });

  it("allows public IP literals", () => {
    expect(validateMcpServerUrl("https://203.0.113.10/mcp").host).toBe("203.0.113.10");
  });
});

describe("assertSafeRedirectTarget", () => {
  it("accepts HTTPS redirect targets", () => {
    expect(assertSafeRedirectTarget("https://auth.example.com/authorize").hostname).toBe(
      "auth.example.com",
    );
  });

  it("rejects redirects to insecure or private targets", () => {
    expect(() => assertSafeRedirectTarget("http://evil.example.com")).toThrow(ApiError);
    expect(() => assertSafeRedirectTarget("https://169.254.169.254/")).toThrow(ApiError);
    expect(() => assertSafeRedirectTarget("https://user:pw@example.com/")).toThrow(ApiError);
  });
});
