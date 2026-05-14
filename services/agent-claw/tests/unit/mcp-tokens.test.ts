// Tests for the MCP Bearer-token signing helper (ADR 006 partial).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

describe("verifyMcpToken — dual-key rotation", () => {
  const SAVED_PRIMARY = process.env.MCP_AUTH_SIGNING_KEY;
  const SAVED_NEXT = process.env.MCP_AUTH_SIGNING_KEY_NEXT;

  beforeEach(() => {
    delete process.env.MCP_AUTH_SIGNING_KEY;
    delete process.env.MCP_AUTH_SIGNING_KEY_NEXT;
  });
  afterEach(() => {
    if (SAVED_PRIMARY === undefined) {
      delete process.env.MCP_AUTH_SIGNING_KEY;
    } else {
      process.env.MCP_AUTH_SIGNING_KEY = SAVED_PRIMARY;
    }
    if (SAVED_NEXT === undefined) {
      delete process.env.MCP_AUTH_SIGNING_KEY_NEXT;
    } else {
      process.env.MCP_AUTH_SIGNING_KEY_NEXT = SAVED_NEXT;
    }
  });

  it("accepts a token signed with MCP_AUTH_SIGNING_KEY_NEXT when primary is rotated", () => {
    const primary = "p".repeat(32);
    const next = "n".repeat(32);
    // Mint a token under the (future-)next key by setting it as primary first.
    process.env.MCP_AUTH_SIGNING_KEY = next;
    const token = signMcpToken({
      sandboxId: "sbx_001",
      userEntraId: "alice@corp.com",
      scopes: ["mcp_kg:read"],
      now: 1_700_000_000,
    });
    // Now flip: verifier has the old key as primary and the new key as _NEXT.
    process.env.MCP_AUTH_SIGNING_KEY = primary;
    process.env.MCP_AUTH_SIGNING_KEY_NEXT = next;
    const claims = verifyMcpToken(token, { now: 1_700_000_000 });
    expect(claims.sub).toBe("sbx_001");
    expect(claims.user).toBe("alice@corp.com");
    expect(claims.scopes).toEqual(["mcp_kg:read"]);
  });

  it("rejects a token signed with a key that is neither primary nor next", () => {
    const primary = "p".repeat(32);
    const next = "n".repeat(32);
    const rogue = "r".repeat(32);
    process.env.MCP_AUTH_SIGNING_KEY = rogue;
    const token = signMcpToken({
      sandboxId: "sbx_001",
      userEntraId: "alice@corp.com",
      scopes: [],
      now: 1_700_000_000,
    });
    process.env.MCP_AUTH_SIGNING_KEY = primary;
    process.env.MCP_AUTH_SIGNING_KEY_NEXT = next;
    expect(() => verifyMcpToken(token, { now: 1_700_000_000 })).toThrow(
      McpAuthError,
    );
  });

  it("behaves identically to single-key mode when MCP_AUTH_SIGNING_KEY_NEXT is unset", () => {
    const primary = "p".repeat(32);
    process.env.MCP_AUTH_SIGNING_KEY = primary;
    // Sanity: a primary-signed token verifies.
    const good = signMcpToken({
      sandboxId: "sbx_001",
      userEntraId: "alice@corp.com",
      scopes: [],
      now: 1_700_000_000,
    });
    const claims = verifyMcpToken(good, { now: 1_700_000_000 });
    expect(claims.sub).toBe("sbx_001");

    // And a token signed under any other key is rejected (since _NEXT is unset).
    const otherKey = "o".repeat(32);
    process.env.MCP_AUTH_SIGNING_KEY = otherKey;
    const bad = signMcpToken({
      sandboxId: "sbx_001",
      userEntraId: "alice@corp.com",
      scopes: [],
      now: 1_700_000_000,
    });
    process.env.MCP_AUTH_SIGNING_KEY = primary;
    expect(() => verifyMcpToken(bad, { now: 1_700_000_000 })).toThrow(
      McpAuthError,
    );
  });

  it("explicit signingKey override suppresses _NEXT (single-key semantic preserved)", () => {
    const primary = "p".repeat(32);
    const next = "n".repeat(32);
    // Mint under _next.
    process.env.MCP_AUTH_SIGNING_KEY = next;
    const token = signMcpToken({
      sandboxId: "sbx_001",
      userEntraId: "alice@corp.com",
      scopes: [],
      now: 1_700_000_000,
    });
    // Set rotation env, but pass an explicit override pointing at primary —
    // verification must NOT fall through to _NEXT.
    process.env.MCP_AUTH_SIGNING_KEY = primary;
    process.env.MCP_AUTH_SIGNING_KEY_NEXT = next;
    expect(() =>
      verifyMcpToken(token, { signingKey: primary, now: 1_700_000_000 }),
    ).toThrow(McpAuthError);
  });
});
