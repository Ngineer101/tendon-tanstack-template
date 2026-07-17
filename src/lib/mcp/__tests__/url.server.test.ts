import { describe, expect, it } from "vitest";

import { ApiError } from "#/lib/api-error";
import { assertSameOriginRedirect, validateOutboundUrl } from "#/lib/mcp/url.server";

function err(fn: () => unknown): ApiError {
  try {
    fn();
    throw new Error("expected ApiError");
  } catch (reason) {
    if (reason instanceof ApiError) return reason;
    throw reason;
  }
}

describe("validateOutboundUrl", () => {
  it("accepts and canonicalises a valid https URL", () => {
    const result = validateOutboundUrl("https://Example.com/MCP/");
    expect(result.url).toBe("https://example.com/MCP");
    expect(result.origin).toBe("https://example.com");
    expect(result.host).toBe("example.com");
    expect(result.protocol).toBe("https:");
  });

  it("preserves the query string and the root path", () => {
    expect(validateOutboundUrl("https://example.com?x=1").url).toBe("https://example.com/?x=1");
  });

  it.each([
    ["empty", ""],
    ["not a url", "not-a-url"],
    ["ftp scheme", "ftp://example.com/mcp"],
  ])("rejects %s", (_label, value) => {
    expect(err(() => validateOutboundUrl(value)).status).toBe(400);
  });

  it("rejects http by default", () => {
    expect(err(() => validateOutboundUrl("http://example.com/mcp")).status).toBe(400);
  });

  it("allows http only when insecure mode is enabled", () => {
    const result = validateOutboundUrl("http://localhost:3000/mcp", { allowInsecureHttp: true });
    expect(result.protocol).toBe("http:");
  });

  it("rejects embedded credentials", () => {
    expect(err(() => validateOutboundUrl("https://user:pass@example.com/mcp")).message).toContain(
      "credentials",
    );
  });

  it("rejects a fragment", () => {
    expect(err(() => validateOutboundUrl("https://example.com/mcp#x")).message).toContain(
      "fragment",
    );
  });

  it.each([
    ["loopback", "https://127.0.0.1/mcp"],
    ["private A", "https://10.0.0.1/mcp"],
    ["private C", "https://192.168.1.1/mcp"],
    ["private B", "https://172.16.0.1/mcp"],
    ["link-local", "https://169.254.1.1/mcp"],
    ["cgNAT", "https://100.64.0.1/mcp"],
  ])("rejects private/RFC1918 addresses: %s", (_label, value) => {
    expect(err(() => validateOutboundUrl(value)).status).toBe(400);
  });

  it.each(["metadata.google.internal", "169.254.169.254", "169.254.170.2"])(
    "rejects cloud metadata host: %s",
    (value) => {
      expect(err(() => validateOutboundUrl(`https://${value}/mcp`)).status).toBe(400);
    },
  );

  it.each([".internal", ".local"])("rejects internal-looking TLDs (%s)", (suffix) => {
    expect(err(() => validateOutboundUrl(`https://host${suffix}/mcp`)).status).toBe(400);
  });

  it("rejects punycode IDN hostnames", () => {
    expect(err(() => validateOutboundUrl("https://xn--mgbh0fb.example/mcp")).message).toContain(
      "Internationalized",
    );
  });

  it("rejects a non-numeric port", () => {
    expect(err(() => validateOutboundUrl("https://example.com:notaport/mcp")).status).toBe(400);
  });

  it("rejects an overly long URL", () => {
    expect(err(() => validateOutboundUrl(`https://example.com/${"a".repeat(2100)}`)).status).toBe(
      400,
    );
  });
});

describe("assertSameOriginRedirect", () => {
  it("passes when origin matches the server", () => {
    expect(() =>
      assertSameOriginRedirect("https://example.com", "https://example.com/mcp/callback"),
    ).not.toThrow();
  });

  it("rejects a cross-origin redirect", () => {
    expect(() =>
      assertSameOriginRedirect("https://example.com", "https://evil.com/callback"),
    ).toThrowError(/same origin|match the server origin/i);
  });

  it("rejects credentials in the redirect URL", () => {
    expect(() =>
      assertSameOriginRedirect("https://example.com", "https://user:pass@example.com/cb"),
    ).toThrowError(/credentials/i);
  });

  it("rejects a non-parseable redirect URL", () => {
    expect(() => assertSameOriginRedirect("https://example.com", "https://")).toThrow();
  });
});
