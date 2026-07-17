import { describe, it, expect } from "vitest";
import { isSafeUrl } from "#/lib/mcp/config";

describe("isSafeUrl", () => {
  it("accepts valid HTTPS URLs", () => {
    expect(isSafeUrl("https://example.com")).toEqual({ valid: true });
    expect(isSafeUrl("https://mcp.example.com/api")).toEqual({ valid: true });
    expect(isSafeUrl("https://my-server.dev:8443")).toEqual({ valid: true });
  });

  it("rejects non-HTTPS schemes", () => {
    expect(isSafeUrl("http://example.com")).toEqual({
      valid: false,
      reason: "Only HTTPS URLs are allowed",
    });
    expect(isSafeUrl("ftp://example.com")).toEqual({
      valid: false,
      reason: "Only HTTPS URLs are allowed",
    });
  });

  it("rejects invalid URLs", () => {
    expect(isSafeUrl("not-a-url")).toEqual({
      valid: false,
      reason: "Invalid URL format",
    });
    expect(isSafeUrl("")).toEqual({
      valid: false,
      reason: "Invalid URL format",
    });
  });

  it("rejects localhost", () => {
    expect(isSafeUrl("https://localhost")).toEqual({
      valid: false,
      reason: "Private or internal URLs are not allowed",
    });
    expect(isSafeUrl("https://localhost:3000")).toEqual({
      valid: false,
      reason: "Private or internal URLs are not allowed",
    });
  });

  it("rejects 127.0.0.1", () => {
    expect(isSafeUrl("https://127.0.0.1")).toEqual({
      valid: false,
      reason: "Private or internal URLs are not allowed",
    });
  });

  it("rejects private IP ranges", () => {
    expect(isSafeUrl("https://10.0.0.1")).toEqual({
      valid: false,
      reason: "Private or internal URLs are not allowed",
    });
    expect(isSafeUrl("https://172.16.0.1")).toEqual({
      valid: false,
      reason: "Private or internal URLs are not allowed",
    });
    expect(isSafeUrl("https://192.168.1.1")).toEqual({
      valid: false,
      reason: "Private or internal URLs are not allowed",
    });
    expect(isSafeUrl("https://169.254.1.1")).toEqual({
      valid: false,
      reason: "Private or internal URLs are not allowed",
    });
  });

  it("rejects .local domains", () => {
    expect(isSafeUrl("https://myservice.local")).toEqual({
      valid: false,
      reason: "Private or internal URLs are not allowed",
    });
  });

  it("rejects .internal domains", () => {
    expect(isSafeUrl("https://myapp.internal")).toEqual({
      valid: false,
      reason: "Private or internal URLs are not allowed",
    });
  });

  it("rejects single-label hostnames", () => {
    expect(isSafeUrl("https://myserver")).toEqual({
      valid: false,
      reason: "Single-label hostnames are not allowed",
    });
  });

  it("rejects raw IPv4 addresses", () => {
    expect(isSafeUrl("https://8.8.8.8")).toEqual({
      valid: false,
      reason: "Raw IP addresses are not allowed",
    });
  });

  it("accepts valid multi-label hostnames", () => {
    expect(isSafeUrl("https://my-mcp-server.example.com")).toEqual({ valid: true });
    expect(isSafeUrl("https://api.mcp.dev")).toEqual({ valid: true });
    expect(isSafeUrl("https://dashboard.my-company.co.uk")).toEqual({ valid: true });
  });

  it("strips trailing slashes gracefully via the callers", () => {
    const url = "https://example.com/".replace(/\/$/, "");
    expect(isSafeUrl(url)).toEqual({ valid: true });
  });
});
