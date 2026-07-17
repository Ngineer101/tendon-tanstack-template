// Tests for the MCP server URL validation + SSRF guards. These are pure logic
// tests (no network) and protect the most safety-critical boundary in the
// connect flow: the URL a user supplies is fetched server-side, so we must
// reject private/loopback/link-local hosts and known cloud metadata endpoints.

import { describe, expect, it } from "vitest";

import { ApiError } from "#/lib/api-error";
import { isSelfOrigin, validateServerUrl } from "#/lib/mcp/ssrf.server";

function expectReject(input: string, options?: { allowLocalhost?: boolean }) {
  expect(() => validateServerUrl(input, options)).toThrow(ApiError);
}

describe("validateServerUrl", () => {
  describe("scheme", () => {
    it("accepts an https URL with no path", () => {
      const result = validateServerUrl("https://mcp.example.com");
      expect(result.url).toBe("https://mcp.example.com/");
      expect(result.hostname).toBe("mcp.example.com");
    });

    it("rejects a non-http(s) scheme", () => {
      expectReject("file:///etc/passwd");
      expectReject("ftp://mcp.example.com");
    });

    it("rejects http outside localhost when localhost is not allowed", () => {
      expectReject("http://mcp.example.com");
    });

    it("allows http://localhost when allowLocalhost is true", () => {
      const result = validateServerUrl("http://localhost:3000", { allowLocalhost: true });
      expect(result.hostname).toBe("localhost");
    });

    it("allows http://127.0.0.1 only when allowLocalhost is set (localhost explicit)", () => {
      // 127.0.0.1 is loopback IP — blocked even with allowLocalhost via the IP guard.
      expectReject("http://127.0.0.1:3000", { allowLocalhost: true });
    });
  });

  describe("malformed input", () => {
    it("rejects empty strings", () => expectReject(""));
    it("rejects strings that are not URLs", () => expectReject("not a url"));
    it("rejects strings missing the host", () => expectReject("https://"));
  });

  describe("embedded credentials", () => {
    it("rejects URLs containing userinfo so credentials never leak into logs", () => {
      expectReject("https://user:pass@mcp.example.com");
      expectReject("https://token:x@mcp.example.com");
    });
  });

  describe("private / loopback / link-local IPs", () => {
    it("rejects raw loopback IPv4", () => {
      expectReject("https://127.0.0.1");
      expectReject("https://127.0.1.5");
    });

    it("rejects raw private IPv4 ranges", () => {
      expectReject("https://10.0.0.1");
      expectReject("https://192.168.1.1");
      expectReject("https://172.16.0.1");
      expectReject("https://172.31.255.255");
    });

    it("rejects link-local / cloud metadata IPs", () => {
      expectReject("https://169.254.169.254");
    });

    it("rejects loopback IPv6", () => {
      expectReject("https://[::1]");
    });
  });

  describe("blocked hostnames", () => {
    it("rejects well-known cloud metadata hostnames", () => {
      expectReject("https://metadata.google.internal");
      expectReject("https://metadata");
    });
  });

  describe("path and normalization", () => {
    it("rejects a URL with a path beyond root", () => {
      expectReject("https://mcp.example.com/some/path");
      expectReject("https://mcp.example.com/.well-known/oauth-authorization-server");
    });

    it("strips trailing slash and normalizes to the origin", () => {
      const result = validateServerUrl("https://mcp.example.com/");
      expect(result.url).toBe("https://mcp.example.com/");
      expect(result.origin).toBe("https://mcp.example.com");
    });

    it("drops any query and hash", () => {
      const result = validateServerUrl("https://mcp.example.com/?x=1#frag");
      expect(result.url).toBe("https://mcp.example.com/");
    });
  });
});

describe("isSelfOrigin", () => {
  it("returns true when both origins share a hostname", () => {
    expect(isSelfOrigin("https://app.example.com/path", "https://app.example.com/other")).toBe(
      true,
    );
  });

  it("returns false for different hostnames", () => {
    expect(isSelfOrigin("https://mcp.example.com", "https://app.example.com")).toBe(false);
  });

  it("returns false for malformed input instead of throwing", () => {
    expect(isSelfOrigin("not a url", "https://app.example.com")).toBe(false);
  });
});
