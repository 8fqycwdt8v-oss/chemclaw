// Unit tests for the per-process MCP token cache.
//
// Cycle 4 added:
//   - getMcpToken throws McpAuthError for unknown service names (no
//     silent DEFAULT_SCOPE fallback that produced a guaranteed-403)
//   - audience claim is set to opts.service (cycle 3 wiring covered here)
//
// The cache is module-state, so each test calls clearMcpTokenCache().

import { describe, it, expect, beforeEach } from "vitest";
import {
  getMcpToken,
  clearMcpTokenCache,
  SERVICE_SCOPES,
} from "../../src/security/mcp-token-cache.js";
import { verifyMcpToken, McpAuthError } from "../../src/security/mcp-tokens.js";

const KEY = "test-signing-key-32-bytes-XXXXXX";

beforeEach(() => {
  clearMcpTokenCache();
});

describe("getMcpToken", () => {
  it("returns undefined when MCP_AUTH_SIGNING_KEY is unset", () => {
    const tok = getMcpToken({
      userEntraId: "alice@corp.com",
      service: "mcp-rdkit",
      signingKey: "", // explicit empty
    });
    expect(tok).toBeUndefined();
  });

  it("mints a verifiable token with the service's scope and aud", () => {
    const tok = getMcpToken({
      userEntraId: "alice@corp.com",
      service: "mcp-rdkit",
      signingKey: KEY,
    });
    expect(tok).toBeDefined();
    const claims = verifyMcpToken(tok!, {
      signingKey: KEY,
      expectedAudience: "mcp-rdkit",
    });
    expect(claims.user).toBe("alice@corp.com");
    expect(claims.scopes).toEqual([SERVICE_SCOPES["mcp-rdkit"]]);
    expect(claims.aud).toBe("mcp-rdkit");
  });

  it("rejects an unknown service name at mint-time", () => {
    expect(() =>
      getMcpToken({
        userEntraId: "alice@corp.com",
        service: "mcp-nonexistent",
        signingKey: KEY,
      }),
    ).toThrow(McpAuthError);
  });

  it("rejects a typo'd service name (underscore vs hyphen)", () => {
    // The Python services use hyphens (mcp-rdkit). A caller using the
    // underscore form should fail loud, not mint a 403-guaranteed token.
    expect(() =>
      getMcpToken({
        userEntraId: "alice@corp.com",
        service: "mcp_rdkit",
        signingKey: KEY,
      }),
    ).toThrow(/unknown MCP service/);
  });

  it("caches tokens for the same (user, service) pair", () => {
    const t1 = getMcpToken({
      userEntraId: "alice@corp.com",
      service: "mcp-kg",
      signingKey: KEY,
    });
    const t2 = getMcpToken({
      userEntraId: "alice@corp.com",
      service: "mcp-kg",
      signingKey: KEY,
    });
    expect(t1).toBe(t2); // same string from cache
  });

  it("mints distinct tokens for different services (per-service aud)", () => {
    const tKg = getMcpToken({
      userEntraId: "alice@corp.com",
      service: "mcp-kg",
      signingKey: KEY,
    });
    const tRdkit = getMcpToken({
      userEntraId: "alice@corp.com",
      service: "mcp-rdkit",
      signingKey: KEY,
    });
    expect(tKg).not.toBe(tRdkit);
    const claimsKg = verifyMcpToken(tKg!, { signingKey: KEY });
    const claimsRdkit = verifyMcpToken(tRdkit!, { signingKey: KEY });
    expect(claimsKg.aud).toBe("mcp-kg");
    expect(claimsRdkit.aud).toBe("mcp-rdkit");
  });

  it("mints a token whose aud doesn't match a peer service", () => {
    // The cycle-3 audience binding: a token minted for mcp-kg must be
    // rejected by mcp-rdkit even though both share the signing key.
    const tok = getMcpToken({
      userEntraId: "alice@corp.com",
      service: "mcp-kg",
      signingKey: KEY,
    });
    expect(() =>
      verifyMcpToken(tok!, {
        signingKey: KEY,
        expectedAudience: "mcp-rdkit",
      }),
    ).toThrow(/audience/);
  });
});

describe("SERVICE_SCOPES catalog", () => {
  it("has every shipped service in a hyphen-named key", () => {
    for (const name of Object.keys(SERVICE_SCOPES)) {
      expect(name).toMatch(/^mcp-/);
      expect(SERVICE_SCOPES[name]).toMatch(/:/); // <resource>:<action>
    }
  });
});
