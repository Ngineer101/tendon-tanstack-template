import { describe, expect, it } from "vitest";

import { ApiError } from "#/lib/api-error";
import { assertSafePublicUrl, canonicalizeServerUrl } from "./url-guard.server";

function expectRejected(raw: string) {
  try {
    assertSafePublicUrl(raw);
    expect.unreachable(`expected ${raw} to be rejected`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).details?.code).toBe("invalid_url");
  }
}

describe("assertSafePublicUrl", () => {
  it("accepts public https URLs", () => {
    expect(assertSafePublicUrl("https://mcp.example.com/mcp").hostname).toBe("mcp.example.com");
    expect(assertSafePublicUrl("https://93.184.216.34/mcp").hostname).toBe("93.184.216.34");
    expect(assertSafePublicUrl("https://mcp.example.com:8443/mcp").port).toBe("8443");
  });

  it("rejects non-https schemes", () => {
    expectRejected("http://mcp.example.com/mcp");
    expectRejected("ftp://mcp.example.com/mcp");
    expectRejected("file:///etc/passwd");
    expectRejected("javascript:alert(1)");
  });

  it("rejects malformed URLs", () => {
    expectRejected("not a url");
    expectRejected("");
  });

  it("rejects URLs with embedded credentials", () => {
    expectRejected("https://user:pass@mcp.example.com/mcp");
  });

  it("rejects loopback and local hostnames", () => {
    expectRejected("https://localhost/mcp");
    expectRejected("https://localhost:3000/mcp");
    expectRejected("https://app.localhost/mcp");
    expectRejected("https://printer.local/mcp");
    expectRejected("https://db.internal/mcp");
    expectRejected("https://intranet/mcp"); // no dot -> not a public host
  });

  it("rejects private and reserved IPv4 ranges", () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata endpoint
      "0.0.0.0",
      "100.64.0.1",
      "192.0.2.10",
      "224.0.0.1",
    ]) {
      expectRejected(`https://${host}/mcp`);
    }
  });

  it("rejects private IPv6 addresses", () => {
    expectRejected("https://[::1]/mcp");
    expectRejected("https://[fd00::1]/mcp");
    expectRejected("https://[fe80::1]/mcp");
    expectRejected("https://[::ffff:127.0.0.1]/mcp");
  });

  it("allows localhost over http only when private networking is enabled", () => {
    const url = assertSafePublicUrl("http://localhost:8931/mcp", { allowPrivateNetwork: true });
    expect(url.port).toBe("8931");
    expectRejected("http://localhost:8931/mcp");
  });
});

describe("canonicalizeServerUrl", () => {
  it("strips trailing slashes and fragments but keeps the query", () => {
    expect(canonicalizeServerUrl(new URL("https://a.example.com/mcp/"))).toBe(
      "https://a.example.com/mcp",
    );
    expect(canonicalizeServerUrl(new URL("https://a.example.com/mcp#frag"))).toBe(
      "https://a.example.com/mcp",
    );
    expect(canonicalizeServerUrl(new URL("https://a.example.com/mcp?tenant=x"))).toBe(
      "https://a.example.com/mcp?tenant=x",
    );
  });
});
