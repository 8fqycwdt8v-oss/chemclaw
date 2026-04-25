// Tests for the tag-maturity post_tool hook.

import { describe, it, expect } from "vitest";
import { stampMaturity, tagMaturityHook } from "../../src/core/hooks/tag-maturity.js";
import type { PostToolPayload } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// stampMaturity unit tests
// ---------------------------------------------------------------------------

describe("stampMaturity", () => {
  it("stamps maturity: EXPLORATORY on a plain object", () => {
    const obj = { result: "some data" };
    const result = stampMaturity(obj) as Record<string, unknown>;
    expect(result["maturity"]).toBe("EXPLORATORY");
  });

  it("does not overwrite an existing maturity field", () => {
    const obj = { result: "data", maturity: "FOUNDATION" };
    const result = stampMaturity(obj) as Record<string, unknown>;
    expect(result["maturity"]).toBe("FOUNDATION");
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
    expect((result as Record<string, unknown>)["maturity"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// tagMaturityHook integration
// ---------------------------------------------------------------------------

describe("tagMaturityHook — payload mutation", () => {
  function makePayload(output: unknown): PostToolPayload {
    return {
      ctx: {
        userEntraId: "test@example.com",
        scratchpad: new Map(),
      },
      toolId: "test_tool",
      input: {},
      output,
    };
  }

  it("stamps object output in-place", async () => {
    const payload = makePayload({ smiles: "CCO", inchikey: "LFQSCWFLJHTTHZ" });
    await tagMaturityHook(payload);
    expect((payload.output as Record<string, unknown>)["maturity"]).toBe("EXPLORATORY");
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
