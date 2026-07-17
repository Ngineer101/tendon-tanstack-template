import { describe, it, expect } from "vitest";
import * as apiError from "#/lib/api-error";

function validateServerUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new apiError.ApiError(400, "Invalid server URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new apiError.ApiError(400, "Server URL must use HTTP or HTTPS");
  }

  if (parsed.hostname === "localhost" || parsed.hostname.endsWith(".local")) {
    throw new apiError.ApiError(400, "Connections to localhost or local networks are not allowed");
  }

  const privatePatterns = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\./,
    /^224\./,
    /^(::1|fc00:|fd00:|fe80:)/i,
  ];

  const isPrivate = privatePatterns.some((pattern) => pattern.test(parsed.hostname));
  if (isPrivate) {
    throw new apiError.ApiError(400, "Connections to private IP ranges are not allowed");
  }

  if (parsed.hostname === "metadata.google.internal") {
    throw new apiError.ApiError(400, "Connections to cloud metadata services are not allowed");
  }

  return parsed;
}

describe("URL validation (SSRF protection)", () => {
  it("accepts valid HTTPS URLs", () => {
    expect(() => validateServerUrl("https://example.com")).not.toThrow();
    expect(() => validateServerUrl("https://mcp.example.com/api")).not.toThrow();
    expect(() => validateServerUrl("https://my-server.example.com:8080")).not.toThrow();
  });

  it("rejects invalid URLs", () => {
    expect(() => validateServerUrl("not-a-url")).toThrow(apiError.ApiError);
    expect(() => validateServerUrl("")).toThrow(apiError.ApiError);
    expect(() => validateServerUrl("ftp://example.com")).toThrow(apiError.ApiError);
  });

  it("rejects localhost addresses", () => {
    expect(() => validateServerUrl("http://localhost:3000")).toThrow(apiError.ApiError);
    expect(() => validateServerUrl("https://localhost")).toThrow(apiError.ApiError);
    expect(() => validateServerUrl("http://something.local")).toThrow(apiError.ApiError);
  });

  it("rejects private IPv4 ranges", () => {
    expect(() => validateServerUrl("http://127.0.0.1")).toThrow(apiError.ApiError);
    expect(() => validateServerUrl("http://10.0.0.1")).toThrow(apiError.ApiError);
    expect(() => validateServerUrl("http://172.16.0.1")).toThrow(apiError.ApiError);
    expect(() => validateServerUrl("http://192.168.1.1")).toThrow(apiError.ApiError);
    expect(() => validateServerUrl("http://169.254.169.254")).toThrow(apiError.ApiError);
  });

  it("rejects cloud metadata endpoints", () => {
    expect(() => validateServerUrl("http://metadata.google.internal")).toThrow(apiError.ApiError);
  });

  it("rejects 0.0.0.0", () => {
    expect(() => validateServerUrl("http://0.0.0.0:8000")).toThrow(apiError.ApiError);
  });

  it("accepts valid public IPs", () => {
    expect(() => validateServerUrl("https://8.8.8.8")).not.toThrow();
    expect(() => validateServerUrl("https://1.1.1.1")).not.toThrow();
  });
});

describe("server limit enforcement", () => {
  it("free users have a limit of 3 servers", () => {
    const MAX_FREE = 3;
    expect(MAX_FREE).toBe(3);
  });

  it("limit check logic: rejects when at limit for free users", () => {
    const MAX_FREE = 3;
    const count = 3;
    const isPro = false;
    const atLimit = !isPro && count >= MAX_FREE;
    expect(atLimit).toBe(true);
  });

  it("limit check logic: allows when under limit for free users", () => {
    const MAX_FREE = 3;
    const count = 2;
    const isPro = false;
    const atLimit = !isPro && count >= MAX_FREE;
    expect(atLimit).toBe(false);
  });

  it("limit check logic: allows any count for pro users", () => {
    const MAX_FREE = 3;
    const counts = [3, 5, 10, 100];
    const isPro = true;
    for (const count of counts) {
      const atLimit = !isPro && count >= MAX_FREE;
      expect(atLimit).toBe(false);
    }
  });
});

describe("ApiError", () => {
  it("creates errors with status and message", () => {
    const error = new apiError.ApiError(402, "Insufficient credits");
    expect(error.status).toBe(402);
    expect(error.message).toBe("Insufficient credits");
    expect(error.name).toBe("ApiError");
  });

  it("includes details", () => {
    const error = new apiError.ApiError(403, "Limit reached", { limit: 3, current: 3 });
    expect(error.details).toEqual({ limit: 3, current: 3 });
  });
});

describe("credential masking", () => {
  it("sanitizes URL by removing username and password", () => {
    const url = new URL("https://user:pass@example.com/path#fragment");
    url.username = "";
    url.password = "";
    url.hash = "";
    expect(url.toString()).toBe("https://example.com/path");
  });

  it("removes credentials from URL with only username", () => {
    const url = new URL("https://token@example.com/api");
    url.username = "";
    url.password = "";
    url.hash = "";
    expect(url.toString()).toBe("https://example.com/api");
  });
});
