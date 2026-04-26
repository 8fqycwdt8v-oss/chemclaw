// Tests for the MCP Bearer-token signing helper (ADR 006 partial).

import { describe, it, expect } from "vitest";
import {
  signMcpToken,
  verifyMcpToken,
  McpAuthError,
} from "../../src/security/mcp-tokens.js";

const KEY = "test-signing-key-32-bytes-XXXXXX";

describe("signMcpToken / verifyMcpToken — round-trip", () => {
  it("verifies a token it just signed", () => {
    const token = signMcpToken({
      sandboxId: "sbx_001",
      userEntraId: "alice@corp.com",
      scopes: ["mcp_kg:read"],
      signingKey: KEY,
      now: 1_700_000_000,
    });
    const claims = verifyMcpToken(token, { signingKey: KEY, now: 1_700_000_000 });
    expect(claims.sub).toBe("sbx_001");
    expect(claims.user).toBe("alice@corp.com");
    expect(claims.scopes).toEqual(["mcp_kg:read"]);
    expect(claims.exp).toBe(1_700_000_000 + 300);
    expect(claims.iat).toBe(1_700_000_000);
  });

  it("rejects a token signed with a different key", () => {
    const token = signMcpToken({
      sandboxId: "sbx_001",
      userEntraId: "alice@corp.com",
      scopes: [],
      signingKey: KEY,
    });
    expect(() => verifyMcpToken(token, { signingKey: "different-key" })).toThrow(
      McpAuthError,
    );
  });

  it("rejects an expired token", () => {
    const token = signMcpToken({
      sandboxId: "sbx_001",
      userEntraId: "alice@corp.com",
      scopes: [],
      ttlSeconds: 60,
      signingKey: KEY,
      now: 1_700_000_000,
    });
    expect(() =>
      verifyMcpToken(token, { signingKey: KEY, now: 1_700_000_000 + 61 }),
    ).toThrow(/expired/);
  });

  it("rejects a token with a tampered payload", () => {
    const token = signMcpToken({
      sandboxId: "sbx_001",
      userEntraId: "alice@corp.com",
      scopes: ["mcp_kg:read"],
      signingKey: KEY,
    });
    const [h, _p, s] = token.split(".") as [string, string, string];
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        sub: "sbx_001",
        user: "mallory@evil.com",
        scopes: ["mcp_kg:read", "mcp_kg:write"],
        exp: 9_999_999_999,
        iat: 0,
      }),
    ).toString("base64url");
    const tampered = `${h}.${tamperedPayload}.${s}`;
    expect(() => verifyMcpToken(tampered, { signingKey: KEY })).toThrow(/bad signature/);
  });

  it("rejects a malformed (non-three-part) token", () => {
    expect(() => verifyMcpToken("not.a.jwt.at.all", { signingKey: KEY })).toThrow(
      /malformed/,
    );
    expect(() => verifyMcpToken("only-one-part", { signingKey: KEY })).toThrow(
      /malformed/,
    );
  });

  it("refuses to sign without a signing key", () => {
    expect(() =>
      signMcpToken({
        sandboxId: "sbx_001",
        userEntraId: "alice@corp.com",
        scopes: [],
        signingKey: "",
      }),
    ).toThrow(/MCP_AUTH_SIGNING_KEY/);
  });
});
