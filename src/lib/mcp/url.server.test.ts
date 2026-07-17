import { describe, expect, it } from "vitest";

import { ApiError } from "#/lib/api-error";
import { validateDiscoveredUrl, validateMcpServerUrl } from "./url.server";

describe("validateMcpServerUrl", () => {
  it.each([
    "https://mcp.example.com",
    "https://mcp.example.com/mcp",
    "https://mcp.example.com:8443/mcp?x=1",
    "https://sub.domain.co.uk/path/to/mcp",
  ])("accepts safe URL %s", (input) => {
    const validated = validateMcpServerUrl(input);
    expect(validated.startsWith("https://")).toBe(true);
  });

  it("normalizes by stripping fragments", () => {
    expect(validateMcpServerUrl("https://mcp.example.com/mcp#frag")).toBe(
      "https://mcp.example.com/mcp",
    );
  });

  it.each([
    ["http://mcp.example.com", "Only https://"],
    ["ftp://mcp.example.com", "Only https://"],
    ["ws://mcp.example.com", "Only https://"],
  ])("rejects non-https URL %s", (input, message) => {
    expect(() => validateMcpServerUrl(input)).toThrowError(
      expect.objectContaining({ status: 400, message: expect.stringContaining(message) }),
    );
  });

  it.each([
    "https://localhost/mcp",
    "https://localhost:3000/mcp",
    "https://foo.localhost/mcp",
    "https://printer.local/mcp",
    "https://gateway.internal/mcp",
    "https://nas.lan/mcp",
  ])("rejects internal hostname %s", (input) => {
    expect(() => validateMcpServerUrl(input)).toThrowError(ApiError);
  });

  it.each([
    "https://127.0.0.1/mcp",
    "https://127.1.2.3/mcp",
    "https://10.0.0.4/mcp",
    "https://172.16.0.1/mcp",
    "https://172.31.255.255/mcp",
    "https://192.168.1.1/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://0.0.0.0/mcp",
    "https://[::1]/mcp",
    "https://[fe80::1]/mcp",
    "https://[fd00::1]/mcp",
    "https://224.0.0.1/mcp",
  ])("rejects private/reserved IP %s", (input) => {
    expect(() => validateMcpServerUrl(input)).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });

  it.each(["https://user:pass@mcp.example.com/mcp", "https://user@mcp.example.com/mcp"])(
    "rejects URLs with embedded credentials %s",
    (input) => {
      expect(() => validateMcpServerUrl(input)).toThrowError(
        expect.objectContaining({ status: 400, message: expect.stringContaining("credentials") }),
      );
    },
  );

  it("rejects single-label hostnames (intranet names)", () => {
    expect(() => validateMcpServerUrl("https://intranet/mcp")).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("rejects unparseable URLs", () => {
    expect(() => validateMcpServerUrl("not a url")).toThrowError(
      expect.objectContaining({ status: 400, message: expect.stringContaining("valid URL") }),
    );
    expect(() => validateMcpServerUrl("")).toThrowError(ApiError);
  });

  it("allows public IP literals (not a private range)", () => {
    expect(() => validateMcpServerUrl("https://203.0.113.10/mcp")).not.toThrow();
  });
});

describe("validateDiscoveredUrl", () => {
  it("wraps unsafe metadata URLs in a 502", () => {
    expect(() =>
      validateDiscoveredUrl("https://169.254.169.254/token", "token endpoint"),
    ).toThrowError(
      expect.objectContaining({ status: 502, message: expect.stringContaining("token endpoint") }),
    );
  });

  it("passes through safe URLs", () => {
    expect(validateDiscoveredUrl("https://auth.example.com/token", "token endpoint")).toBe(
      "https://auth.example.com/token",
    );
  });
});
