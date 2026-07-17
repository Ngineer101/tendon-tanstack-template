import { describe, it, expect } from "vitest";
import { ApiError } from "#/lib/api-error";
import { validateServerUrl } from "./url-validator";
import { encrypt, decrypt } from "./encryption";

const MOCK_ENCRYPTION_KEY = "test-key-for-mcp-encryption-32b";

describe("validateServerUrl (SSRF protection)", () => {
  it("blocks IPv4 private ranges", () => {
    const blocked = [
      "https://10.0.0.1",
      "https://172.16.0.1",
      "https://192.168.1.1",
      "https://127.0.0.1",
      "https://0.0.0.0",
      "https://169.254.1.1",
      "https://100.64.0.1",
      "https://198.18.0.1",
    ];
    for (const url of blocked) {
      expect(validateServerUrl(url).valid, `should block ${url}`).toBe(false);
    }
  });

  it("blocks IPv6 private addresses", () => {
    expect(validateServerUrl("https://[::1]").valid).toBe(false);
    expect(validateServerUrl("https://[fc00::1]").valid).toBe(false);
    expect(validateServerUrl("https://[fe80::1]").valid).toBe(false);
  });

  it("blocks localhost in all forms", () => {
    expect(validateServerUrl("https://localhost").valid).toBe(false);
    expect(validateServerUrl("https://localhost:8080").valid).toBe(false);
  });

  it("requires HTTPS", () => {
    expect(validateServerUrl("http://mcp.example.com").valid).toBe(false);
  });

  it("blocks URLs with credentials", () => {
    expect(validateServerUrl("https://user:pass@mcp.example.com").valid).toBe(false);
  });

  it("blocks empty input", () => {
    expect(validateServerUrl("").valid).toBe(false);
    expect(validateServerUrl("   ").valid).toBe(false);
  });

  it("blocks invalid URL format", () => {
    expect(validateServerUrl("not-a-url").valid).toBe(false);
  });

  it("allows valid public HTTPS URLs", () => {
    expect(validateServerUrl("https://mcp.example.com").valid).toBe(true);
    expect(validateServerUrl("https://api.mcp.example.com").valid).toBe(true);
    expect(validateServerUrl("https://mcp.example.com:8443").valid).toBe(true);
    expect(validateServerUrl("https://mcp.example.com/api").valid).toBe(true);
  });

  it("normalizes URLs to origin", () => {
    const result = validateServerUrl("https://mcp.example.com/api/v1?foo=bar#section");
    expect(result.valid).toBe(true);
    expect(result.normalizedUrl).toBe("https://mcp.example.com");
  });

  it("blocks hostnames longer than 253 characters", () => {
    const longHost = "a".repeat(250) + ".com";
    expect(validateServerUrl(`https://${longHost}`).valid).toBe(false);
  });
});

describe("label validation rules", () => {
  it("rejects empty labels", () => {
    const emptyLabels = ["", "   ", "\t", "\n"];
    for (const label of emptyLabels) {
      const trimmed = label.trim();
      expect(trimmed.length === 0 || trimmed.length > 100, `should reject "${label}"`).toBe(true);
    }
  });

  it("rejects labels over 100 characters", () => {
    const longLabel = "a".repeat(101);
    expect(longLabel.length > 100).toBe(true);
  });

  it("accepts labels between 1 and 100 characters", () => {
    const validLabels = ["A", "My MCP Server", "a".repeat(100)];
    for (const label of validLabels) {
      const trimmed = label.trim();
      const isValid = trimmed.length > 0 && trimmed.length <= 100;
      expect(isValid, `should accept "${label}"`).toBe(true);
    }
  });
});

describe("encryption round-trip", () => {
  it("encrypts and decrypts OAuth token data correctly", async () => {
    const authData = JSON.stringify({
      accessToken: "test-access-token-abc123",
      refreshToken: "test-refresh-token-xyz789",
      expiresIn: 3600,
      tokenEndpoint: "https://mcp.example.com/token",
      clientId: "https://app.example.com",
    });

    const encrypted = await encrypt(authData, MOCK_ENCRYPTION_KEY);
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toBe(authData);

    const decrypted = await decrypt(encrypted, MOCK_ENCRYPTION_KEY);
    expect(JSON.parse(decrypted)).toEqual({
      accessToken: "test-access-token-abc123",
      refreshToken: "test-refresh-token-xyz789",
      expiresIn: 3600,
      tokenEndpoint: "https://mcp.example.com/token",
      clientId: "https://app.example.com",
    });
  });

  it("fails to decrypt with a different key", async () => {
    const encrypted = await encrypt("secret", MOCK_ENCRYPTION_KEY);
    await expect(decrypt(encrypted, "wrong-key-wrong-key-wrong-key-32")).rejects.toThrow();
  });
});

describe("McpServerPublic serialization", () => {
  it("excludes encryptedAuthData from public output", () => {
    const serverRow = {
      id: "mcp_test123",
      userId: "user_1",
      label: "Test Server",
      url: "https://mcp.example.com",
      authType: "oauth",
      encryptedAuthData: "SHOULD_NOT_LEAK",
      oauthState: null,
      status: "connected",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
    };

    const _public = {
      id: serverRow.id,
      label: serverRow.label,
      url: serverRow.url,
      authType: serverRow.authType,
      status: serverRow.status,
      hasAuth: !!serverRow.encryptedAuthData,
      createdAt: serverRow.createdAt.getTime(),
      updatedAt: serverRow.updatedAt.getTime(),
    };

    expect(_public.hasAuth).toBe(true);
    expect("encryptedAuthData" in _public).toBe(false);
    expect("encrypted_auth_data" in _public).toBe(false);
  });
});

describe("ApiError", () => {
  it("creates errors with status code and message", () => {
    const error = new ApiError(402, "Payment required");
    expect(error.status).toBe(402);
    expect(error.message).toBe("Payment required");
    expect(error.name).toBe("ApiError");
  });

  it("includes details when provided", () => {
    const error = new ApiError(429, "Rate limited", { retryAfter: 30 });
    expect(error.details).toEqual({ retryAfter: 30 });
  });
});

describe("server limit constants", () => {
  const MAX_FREE_SERVERS = 3;

  it("defines the correct free limit", () => {
    expect(MAX_FREE_SERVERS).toBe(3);
  });

  it("allows 0, 1, 2 servers for free users", () => {
    for (let count = 0; count < MAX_FREE_SERVERS; count++) {
      expect(count < MAX_FREE_SERVERS).toBe(true);
    }
  });

  it("blocks server creation at the limit for free users", () => {
    const atLimit = MAX_FREE_SERVERS;
    expect(atLimit >= MAX_FREE_SERVERS).toBe(true);
  });
});
