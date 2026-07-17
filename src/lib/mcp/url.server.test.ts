import { describe, expect, it, vi } from "vitest";

import { ApiError } from "#/lib/api-error";
import {
  assertPubliclyResolvable,
  isPublicHostname,
  parsePublicHttpUrl,
  sanitizeForLog,
} from "./url.server";

describe("parsePublicHttpUrl", () => {
  it("accepts public https URLs", () => {
    expect(parsePublicHttpUrl("https://mcp.example.com/mcp").toString()).toBe(
      "https://mcp.example.com/mcp",
    );
    expect(parsePublicHttpUrl("https://api.linear.app:8443/sse").host).toBe("api.linear.app:8443");
    expect(parsePublicHttpUrl("  https://mcp.notion.com/mcp  ").host).toBe("mcp.notion.com");
  });

  it("rejects non-https URLs", () => {
    expect(() => parsePublicHttpUrl("http://mcp.example.com/mcp")).toThrowError(ApiError);
    expect(() => parsePublicHttpUrl("ftp://example.com")).toThrowError(/http\(s\)/);
    expect(() => parsePublicHttpUrl("file:///etc/passwd")).toThrowError(ApiError);
  });

  it("rejects malformed or empty input", () => {
    expect(() => parsePublicHttpUrl("")).toThrowError(/valid server URL/);
    expect(() => parsePublicHttpUrl("not a url")).toThrowError(/valid URL/);
    expect(() => parsePublicHttpUrl(`https://example.com/${"a".repeat(3000)}`)).toThrowError(
      ApiError,
    );
  });

  it("rejects URLs with embedded credentials", () => {
    expect(() => parsePublicHttpUrl("https://user:pass@mcp.example.com/mcp")).toThrowError(
      /credentials/,
    );
  });

  it.each([
    "https://localhost/mcp",
    "https://localhost./mcp",
    "https://foo.localhost/mcp",
    "https://127.0.0.1/mcp",
    "https://127.1/mcp",
    "https://2130706433/mcp", // decimal encoding of 127.0.0.1
    "https://0x7f000001/mcp", // hex encoding of 127.0.0.1
    "https://10.0.0.4/mcp",
    "https://172.16.0.1/mcp",
    "https://172.31.255.255/mcp",
    "https://192.168.1.1/mcp",
    "https://169.254.169.254/latest/meta-data", // cloud metadata endpoint
    "https://100.64.0.1/mcp", // CGNAT
    "https://0.0.0.0/mcp",
    "https://192.0.2.1/mcp", // TEST-NET-1
    "https://198.51.100.7/mcp", // TEST-NET-2
    "https://224.0.0.1/mcp", // multicast
    "https://[::1]/mcp", // IPv6 loopback
    "https://[fe80::1]/mcp", // IPv6 link-local
    "https://[fd00::1]/mcp", // IPv6 ULA
    "https://[::ffff:127.0.0.1]/mcp", // IPv4-mapped loopback
    "https://printer.local/mcp",
    "https://metadata.google.internal/mcp",
    "https://db.internal/mcp",
  ])("rejects internal address %s", (input) => {
    expect(() => parsePublicHttpUrl(input)).toThrowError(/public host/);
  });
});

describe("isPublicHostname", () => {
  it("accepts regular domains and public IPs", () => {
    expect(isPublicHostname("mcp.example.com")).toBe(true);
    expect(isPublicHostname("93.184.216.34")).toBe(true);
    expect(isPublicHostname("[2606:4700:4700::1111]")).toBe(true);
  });
});

describe("assertPubliclyResolvable", () => {
  it("passes when DNS answers contain only public addresses", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ Answer: [{ data: "93.184.216.34" }] }), { status: 200 }),
    );
    await expect(
      assertPubliclyResolvable(new URL("https://mcp.example.com/mcp"), fetchFn as typeof fetch),
    ).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalled();
  });

  it("rejects when any DNS answer is a private address", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(
        JSON.stringify({
          Answer: href.includes("AAAA")
            ? [{ data: "2606:4700:4700::1111" }]
            : [{ data: "93.184.216.34" }, { data: "169.254.169.254" }],
        }),
        { status: 200 },
      );
    });
    await expect(
      assertPubliclyResolvable(new URL("https://sneaky.example.com/mcp"), fetchFn as typeof fetch),
    ).rejects.toThrowError(/public host/);
  });

  it("fails closed when the hostname cannot be resolved", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(
      assertPubliclyResolvable(new URL("https://missing.example.com/mcp"), fetchFn as typeof fetch),
    ).rejects.toThrowError(/could not be resolved/);
  });

  it("skips resolution for literal IPs", async () => {
    const fetchFn = vi.fn();
    await expect(
      assertPubliclyResolvable(new URL("https://93.184.216.34/mcp"), fetchFn as typeof fetch),
    ).resolves.toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("sanitizeForLog", () => {
  it("strips query strings and token-like material", () => {
    const dirty =
      "Request failed for https://api.example.com/token?code=abc123 with bearer fake_secret_token_abcdefghijklmnopqrstuvwxyz";
    const clean = sanitizeForLog(dirty);
    expect(clean).not.toContain("abc123");
    expect(clean).not.toContain("fake_secret_token_abcdefghijklmnopqrstuvwxyz");
    expect(clean).toContain("[redacted]");
  });

  it("truncates long messages", () => {
    expect(sanitizeForLog("short token ".repeat(100))).toHaveLength(200);
  });
});
