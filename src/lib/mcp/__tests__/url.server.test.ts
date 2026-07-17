import { describe, expect, it } from "vitest";

import { ApiError } from "#/lib/api-error";
import { isPrivateHost, validateMcpServerUrl, validateRedirect } from "#/lib/mcp/url.server";

function expectErrorStatus(fn: () => unknown, status: number) {
  try {
    fn();
    throw new Error("expected ApiError");
  } catch (err) {
    if (!(err instanceof ApiError)) throw new Error(`expected ApiError, got ${String(err)}`);
    expect(err.status).toBe(status);
  }
}

describe("validateMcpServerUrl", () => {
  it("accepts a normal https URL", () => {
    const { href, origin, host } = validateMcpServerUrl("https://mcp.example.com/path/");
    expect(origin).toBe("https://mcp.example.com");
    expect(host).toBe("mcp.example.com");
    expect(href).toBe("https://mcp.example.com/path/");
  });

  it("strips the URL fragment", () => {
    expect(validateMcpServerUrl("https://mcp.example.com/#frag").href).toBe(
      "https://mcp.example.com/",
    );
  });

  it("rejects non-https schemes", () => {
    expectErrorStatus(() => validateMcpServerUrl("ftp://mcp.example.com"), 400);
    expectErrorStatus(() => validateMcpServerUrl("file:///etc/passwd"), 400);
  });

  it("rejects http for non-loopback hosts", () => {
    expectErrorStatus(() => validateMcpServerUrl("http://mcp.example.com"), 400);
  });

  it("allows http+loopback only when explicitly permitted", () => {
    expect(() =>
      validateMcpServerUrl("http://localhost:3000", { allowLoopbackHttp: true }),
    ).not.toThrow();
    expectErrorStatus(() => validateMcpServerUrl("http://localhost:3000"), 400);
  });

  it("rejects credentials embedded in the URL", () => {
    expectErrorStatus(() => validateMcpServerUrl("https://user:pass@mcp.example.com"), 400);
  });

  it("rejects malformed URLs", () => {
    expectErrorStatus(() => validateMcpServerUrl("not a url"), 400);
    expectErrorStatus(() => validateMcpServerUrl(""), 400);
  });

  it("blocks SSRF to private IPv4 hosts", () => {
    for (const host of ["10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254"]) {
      expectErrorStatus(() => validateMcpServerUrl(`https://${host}/`), 422);
    }
  });

  it("blocks link-local / unique-local IPv6", () => {
    expectErrorStatus(() => validateMcpServerUrl("https://[fd00::1]"), 422);
    expectErrorStatus(() => validateMcpServerUrl("https://[fe80::1]"), 422);
  });

  it("blocks the v4-mapped wildcard", () => {
    expectErrorStatus(() => validateMcpServerUrl("https://[::ffff:169.254.169.254]"), 422);
  });
});

describe("isPrivateHost", () => {
  it("treats loopback as non-private", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(false);
    expect(isPrivateHost("localhost")).toBe(false);
  });
});

describe("validateRedirect", () => {
  it("re-validates a redirect target against the SSRF rules", () => {
    expect(validateRedirect("/v2/metadata", "https://mcp.example.com").href).toBe(
      "https://mcp.example.com/v2/metadata",
    );
  });

  it("rejects redirects to private hosts (SSRF guard)", () => {
    expectErrorStatus(
      () => validateRedirect("https://169.254.169.254/latest/meta-data", "https://mcp.example.com"),
      422,
    );
  });

  it("rejects empty redirect locations", () => {
    expectErrorStatus(() => validateRedirect("", "https://mcp.example.com"), 502);
  });
});
