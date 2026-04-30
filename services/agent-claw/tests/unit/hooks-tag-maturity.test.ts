// Tests for the tag-maturity post_tool hook.

import { describe, it, expect } from "vitest";
import { stampMaturity, tagMaturityHook, resolveMaturity } from "../../src/core/hooks/tag-maturity.js";
import type { PostToolPayload } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// stampMaturity unit tests
// ---------------------------------------------------------------------------

describe("stampMaturity", () => {
  it("stamps maturity: EXPLORATORY on a plain object", () => {
    const obj = { result: "some data" };
    const result = stampMaturity(obj) as Record<string, unknown>;
    expect(result.maturity).toBe("EXPLORATORY");
  });

  it("does not overwrite an existing maturity field", () => {
    const obj = { result: "data", maturity: "FOUNDATION" };
    const result = stampMaturity(obj) as Record<string, unknown>;
    expect(result.maturity).toBe("FOUNDATION");
  });

  it("is a no-op for a string (primitive)", () => {
    expect(stampMaturity("hello")).toBe("hello");
  });

  it("is a no-op for a number (primitive)", () => {
    expect(stampMaturity(42)).toBe(42);
  });

  it("is a no-op for null", () => {
    expect(stampMaturity(null)).toBeNull();
  });

  it("is a no-op for an array", () => {
    const arr = [1, 2, 3];
    const result = stampMaturity(arr);
    expect(result).toEqual([1, 2, 3]);
    // Arrays are not stamped.
    expect((result as Record<string, unknown>).maturity).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// tagMaturityHook integration
// ---------------------------------------------------------------------------

describe("tagMaturityHook — payload mutation", () => {
  function makePayload(output: unknown): PostToolPayload {
    const seenFactIds = new Set<string>();
    const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
    return {
      ctx: {
        userEntraId: "test@example.com",
        scratchpad,
        seenFactIds,
      },
      toolId: "test_tool",
      input: {},
      output,
    };
  }

  it("stamps object output in-place", async () => {
    const payload = makePayload({ smiles: "CCO", inchikey: "LFQSCWFLJHTTHZ" });
    await tagMaturityHook(payload);
    expect((payload.output as Record<string, unknown>).maturity).toBe("EXPLORATORY");
  });

  it("is a no-op for primitive output", async () => {
    const payload = makePayload("plain string");
    await tagMaturityHook(payload);
    expect(payload.output).toBe("plain string");
  });

  it("is a no-op for null output", async () => {
    const payload = makePayload(null);
    await tagMaturityHook(payload);
    expect(payload.output).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase C: resolveMaturity + artifactMaturity scratchpad population
// ---------------------------------------------------------------------------

describe("resolveMaturity", () => {
  it("returns EXPLORATORY for a plain object without a maturity field", () => {
    expect(resolveMaturity({ result: "data" })).toBe("EXPLORATORY");
  });

  it("returns WORKING when the output already has maturity=WORKING", () => {
    expect(resolveMaturity({ maturity: "WORKING" })).toBe("WORKING");
  });

  it("returns FOUNDATION when the output already has maturity=FOUNDATION", () => {
    expect(resolveMaturity({ maturity: "FOUNDATION" })).toBe("FOUNDATION");
  });

  it("returns EXPLORATORY for null", () => {
    expect(resolveMaturity(null)).toBe("EXPLORATORY");
  });
});

describe("tagMaturityHook — Phase C scratchpad population", () => {
  it("creates the artifactMaturity map in scratchpad if absent", async () => {
    const seenFactIds = new Set<string>();
    const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
    const payload: PostToolPayload = {
      ctx: { userEntraId: "test@example.com", scratchpad, seenFactIds },
      toolId: "propose_hypothesis",
      input: {},
      output: { hypothesis_id: "h-001", confidence: 0.8 },
    };
    // No pool — artifact DB write is skipped; map should still be created.
    await tagMaturityHook(payload);
    const maturityMap = scratchpad.get("artifactMaturity");
    expect(maturityMap).toBeInstanceOf(Map);
  });

  it("records hypothesis_id in the artifactMaturity map", async () => {
    const seenFactIds = new Set<string>();
    const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
    const payload: PostToolPayload = {
      ctx: { userEntraId: "test@example.com", scratchpad, seenFactIds },
      toolId: "propose_hypothesis",
      input: {},
      output: { hypothesis_id: "hyp-abc-123", confidence: 0.7 },
    };
    await tagMaturityHook(payload);
    const maturityMap = scratchpad.get("artifactMaturity") as Map<string, string>;
    expect(maturityMap.get("hyp-abc-123")).toBe("EXPLORATORY");
  });
});
