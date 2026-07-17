import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "#/lib/api-error";
import { assertSafeHttpUrl, safeFetch } from "./url-security.server";

describe("assertSafeHttpUrl", () => {
  it("accepts public https URLs", () => {
    expect(assertSafeHttpUrl("https://mcp.example.com/mcp").href).toBe(
      "https://mcp.example.com/mcp",
    );
    expect(assertSafeHttpUrl("https://8.8.8.8/mcp").hostname).toBe("8.8.8.8");
  });

  it.each([
    ["http://mcp.example.com/mcp", "plain http"],
    ["ftp://mcp.example.com", "non-http scheme"],
    ["file:///etc/passwd", "file scheme"],
    ["not a url", "garbage"],
    ["https://user:pass@mcp.example.com", "embedded credentials"],
    ["https://localhost/mcp", "localhost"],
    ["https://foo.localhost/mcp", "localhost subdomain"],
    ["https://internal.local/mcp", ".local"],
    ["https://db.internal/mcp", ".internal"],
    ["https://127.0.0.1/mcp", "loopback"],
    ["https://127.0.0.1./mcp", "loopback with trailing dot"],
    ["https://2130706433/mcp", "decimal-encoded loopback"],
    ["https://0x7f000001/mcp", "hex-encoded loopback"],
    ["https://10.1.2.3/mcp", "10/8 private"],
    ["https://172.16.0.9/mcp", "172.16/12 private"],
    ["https://192.168.1.1/mcp", "192.168/16 private"],
    ["https://169.254.169.254/latest/meta-data", "cloud metadata"],
    ["https://100.64.0.1/mcp", "CGNAT"],
    ["https://0.0.0.0/mcp", "unspecified"],
    ["https://[::1]/mcp", "IPv6 loopback"],
    ["https://[::]/mcp", "IPv6 unspecified"],
    ["https://[fc00::1]/mcp", "IPv6 unique local"],
    ["https://[fe80::1]/mcp", "IPv6 link local"],
    ["https://[::ffff:192.168.1.1]/mcp", "IPv4-mapped private"],
    ["https://[64:ff9b::a00:1]/mcp", "NAT64"],
  ])("rejects %s (%s)", (url) => {
    expect(() => assertSafeHttpUrl(url)).toThrow(ApiError);
  });
});

describe("safeFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(responses: Array<Response | (() => Response)>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let index = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        calls.push({ url, init });
        const next = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return Promise.resolve(typeof next === "function" ? next() : next);
      }),
    );
    return calls;
  }

  it("never auto-follows redirects at the fetch layer", async () => {
    const calls = stubFetch([new Response("ok")]);
    await safeFetch("https://mcp.example.com/mcp");
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  it("follows safe GET redirects and re-validates each hop", async () => {
    const calls = stubFetch([
      new Response(null, { status: 302, headers: { location: "https://other.example.com/doc" } }),
      new Response("ok"),
    ]);
    const response = await safeFetch("https://mcp.example.com/doc");
    expect(response.status).toBe(200);
    expect(calls[1]?.url).toBe("https://other.example.com/doc");
  });

  it("blocks redirects into private address space", async () => {
    stubFetch([
      new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
      }),
    ]);
    await expect(safeFetch("https://mcp.example.com/doc")).rejects.toThrow(ApiError);
  });

  it("refuses to follow redirects for non-GET requests", async () => {
    stubFetch([
      new Response(null, { status: 302, headers: { location: "https://other.example.com" } }),
    ]);
    await expect(safeFetch("https://mcp.example.com/token", { method: "POST" })).rejects.toThrow(
      "unexpected redirect",
    );
  });

  it("drops authorization headers on cross-origin redirects", async () => {
    const calls = stubFetch([
      new Response(null, { status: 302, headers: { location: "https://other.example.com/doc" } }),
      new Response("ok"),
    ]);
    await safeFetch("https://mcp.example.com/doc", {
      headers: { authorization: "Bearer secret" },
    });
    const forwarded = new Headers(calls[1]?.init.headers);
    expect(forwarded.get("authorization")).toBeNull();
  });

  it("gives up after too many redirects", async () => {
    stubFetch([
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://mcp.example.com/loop" },
        }),
    ]);
    await expect(safeFetch("https://mcp.example.com/doc")).rejects.toThrow("unexpected redirect");
  });
});
