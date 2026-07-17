import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "#/lib/api-error";
import { assertSafeExternalUrl, safeFetch } from "./url-security.server";

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof ApiError ? error.status : undefined;
  }
}

describe("assertSafeExternalUrl", () => {
  it("accepts public HTTPS URLs", () => {
    expect(assertSafeExternalUrl("https://mcp.example.com/mcp").hostname).toBe("mcp.example.com");
    expect(assertSafeExternalUrl("https://mcp.example.com:8443/tools").port).toBe("8443");
  });

  it("rejects invalid and non-HTTPS URLs", () => {
    expect(statusOf(() => assertSafeExternalUrl("not a url"))).toBe(400);
    expect(statusOf(() => assertSafeExternalUrl("http://mcp.example.com/mcp"))).toBe(400);
    expect(statusOf(() => assertSafeExternalUrl("ftp://mcp.example.com"))).toBe(400);
    expect(statusOf(() => assertSafeExternalUrl("file:///etc/passwd"))).toBe(400);
  });

  it("rejects URLs with embedded credentials", () => {
    expect(statusOf(() => assertSafeExternalUrl("https://user:pass@example.com/mcp"))).toBe(400);
  });

  it("rejects loopback and private hosts", () => {
    for (const url of [
      "https://localhost/mcp",
      "https://127.0.0.1/mcp",
      "https://127.8.9.1/mcp",
      "https://0.0.0.0/mcp",
      "https://10.0.0.5/mcp",
      "https://100.64.1.1/mcp",
      "https://169.254.169.254/latest/meta-data",
      "https://172.16.0.1/mcp",
      "https://172.31.255.255/mcp",
      "https://192.168.1.1/mcp",
      "https://[::1]/mcp",
      "https://[fd00::1]/mcp",
      "https://metadata.google.internal/computeMetadata",
      "https://foo.internal/mcp",
      "https://printer.local/mcp",
      "https://dev.localhost/mcp",
    ]) {
      expect(
        statusOf(() => assertSafeExternalUrl(url)),
        url,
      ).toBe(400);
    }
  });

  it("rejects numeric IPv4 encodings that normalise to private addresses", () => {
    // WHATWG URL normalises 2130706433 -> 127.0.0.1 and 0x7f000001 -> 127.0.0.1
    expect(statusOf(() => assertSafeExternalUrl("https://2130706433/mcp"))).toBe(400);
    expect(statusOf(() => assertSafeExternalUrl("https://0x7f000001/mcp"))).toBe(400);
  });

  it("allows plain-HTTP loopback only with the development flag", () => {
    expect(statusOf(() => assertSafeExternalUrl("http://localhost:4001/mcp"))).toBe(400);
    expect(
      assertSafeExternalUrl("http://localhost:4001/mcp", { allowInsecureLocalhost: true }).port,
    ).toBe("4001");
    // The flag must not open up private ranges beyond loopback.
    expect(
      statusOf(() =>
        assertSafeExternalUrl("http://192.168.1.1/mcp", { allowInsecureLocalhost: true }),
      ),
    ).toBe(400);
  });
});

describe("safeFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses to follow redirects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { location: "https://evil.example.com" } }),
      ),
    );

    await expect(safeFetch("https://mcp.example.com/mcp", { method: "GET" })).rejects.toMatchObject(
      { status: 502 },
    );
  });

  it("requests with redirect: manual", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await safeFetch("https://mcp.example.com/mcp", { method: "GET" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://mcp.example.com/mcp",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("validates the target before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(safeFetch("https://10.0.0.1/mcp", { method: "GET" })).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
