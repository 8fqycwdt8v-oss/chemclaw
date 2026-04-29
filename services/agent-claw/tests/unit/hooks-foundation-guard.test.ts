// Tests for the foundation-citation-guard pre_tool hook — Phase C.4
//
// Phase 4A migrated this hook from `throw` to a deny-decision return. The
// tests here verify both:
//   1. The hook returns the no-op HookJSONOutput shape ({}) when there's
//      nothing to enforce.
//   2. The hook returns a deny-decision (with reason) when a FOUNDATION
//      claim cites EXPLORATORY artifacts.
//   3. The lifecycle dispatcher surfaces that deny-decision via its
//      DispatchResult — step.ts is what actually short-circuits tool exec.

import { describe, it, expect } from "vitest";
import {
  foundationCitationGuardHook,
  registerFoundationCitationGuardHook,
} from "../../src/core/hooks/foundation-citation-guard.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import type { PreToolPayload } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(input: unknown, maturityEntries: [string, string][] = []): PreToolPayload {
  const maturityMap = new Map<string, string>(maturityEntries);
  const scratchpad = new Map<string, unknown>([
    ["artifactMaturity", maturityMap],
    ["seenFactIds", new Set<string>()],
  ]);
  return {
    ctx: {
      userEntraId: "test@example.com",
      scratchpad,
      seenFactIds: new Set<string>(),
    },
    toolId: "test_tool",
    input,
  };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("foundationCitationGuardHook", () => {
  it("is a no-op when input has no maturity_tier field", async () => {
    const payload = makePayload({ cited_fact_ids: ["abc-123"] });
    await expect(foundationCitationGuardHook(payload)).resolves.toEqual({});
  });

  it("is a no-op when maturity_tier is WORKING", async () => {
    const payload = makePayload(
      { maturity_tier: "WORKING", cited_fact_ids: ["abc-123"] },
      [["abc-123", "EXPLORATORY"]],
    );
    await expect(foundationCitationGuardHook(payload)).resolves.toEqual({});
  });

  it("is a no-op when no artifactMaturity map is set", async () => {
    const scratchpad = new Map<string, unknown>();
    const payload: PreToolPayload = {
      ctx: { userEntraId: "test@example.com", scratchpad, seenFactIds: new Set() },
      toolId: "test_tool",
      input: { maturity_tier: "FOUNDATION", cited_fact_ids: ["abc-123"] },
    };
    await expect(foundationCitationGuardHook(payload)).resolves.toEqual({});
  });

  it("is a no-op when all cited artifacts are WORKING or FOUNDATION", async () => {
    const payload = makePayload(
      {
        maturity_tier: "FOUNDATION",
        cited_fact_ids: ["fact-1", "fact-2"],
      },
      [
        ["fact-1", "WORKING"],
        ["fact-2", "FOUNDATION"],
      ],
    );
    await expect(foundationCitationGuardHook(payload)).resolves.toEqual({});
  });

  it("returns a deny decision when a FOUNDATION claim cites an EXPLORATORY artifact", async () => {
    const payload = makePayload(
      {
        maturity_tier: "FOUNDATION",
        cited_fact_ids: ["fact-exp"],
      },
      [["fact-exp", "EXPLORATORY"]],
    );
    const result = await foundationCitationGuardHook(payload);
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "pre_tool",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/foundation-citation-guard/),
      },
    });
  });

  it("denies with a reason listing all offending IDs", async () => {
    const payload = makePayload(
      {
        maturity_tier: "FOUNDATION",
        evidence_fact_ids: ["exp-1", "exp-2"],
      },
      [
        ["exp-1", "EXPLORATORY"],
        ["exp-2", "EXPLORATORY"],
      ],
    );
    const result = await foundationCitationGuardHook(payload);
    const reason =
      (result as { hookSpecificOutput?: { permissionDecisionReason?: string } })
        .hookSpecificOutput?.permissionDecisionReason ?? "";
    expect(reason).toMatch(/exp-1.*exp-2|exp-2.*exp-1/);
  });

  it("is a no-op for null input", async () => {
    const payload = makePayload(null);
    await expect(foundationCitationGuardHook(payload)).resolves.toEqual({});
  });

  it("is a no-op for array input", async () => {
    const payload = makePayload([{ maturity_tier: "FOUNDATION" }]);
    await expect(foundationCitationGuardHook(payload)).resolves.toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Integration: Lifecycle registration
// ---------------------------------------------------------------------------

describe("registerFoundationCitationGuardHook", () => {
  it("registers the hook on pre_tool", () => {
    const lc = new Lifecycle();
    expect(lc.count("pre_tool")).toBe(0);
    registerFoundationCitationGuardHook(lc);
    expect(lc.count("pre_tool")).toBe(1);
  });

  it("the registered hook surfaces a deny decision via dispatch when guard fires", async () => {
    const lc = new Lifecycle();
    registerFoundationCitationGuardHook(lc);

    const payload = makePayload(
      {
        maturity_tier: "FOUNDATION",
        cited_fact_ids: ["exploratory-id"],
      },
      [["exploratory-id", "EXPLORATORY"]],
    );

    const result = await lc.dispatch("pre_tool", payload);
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/foundation-citation-guard/);
  });
});
