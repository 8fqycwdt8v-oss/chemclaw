// Phase A1 — loop-detector pre_tool hook unit tests.

import { describe, it, expect } from "vitest";
import {
  loopDetectorHook,
  hashToolInput,
  RECENT_TOOL_CALLS_KEY,
  LOOP_WARNINGS_KEY,
  STUCK_THRESHOLD,
  HARD_DENY_THRESHOLD,
  type LoopWarning,
  type RecentToolCall,
} from "../../src/core/hooks/loop-detector.js";
import type { ToolContext, PreToolPayload } from "../../src/core/types.js";

function makeCtx(): ToolContext {
  return {
    userEntraId: "u",
    scratchpad: new Map<string, unknown>(),
    seenFactIds: new Set<string>(),
  };
}

function makePayload(ctx: ToolContext, toolId: string, input: unknown): PreToolPayload {
  return { ctx, toolId, input };
}

describe("loop-detector — hashToolInput", () => {
  it("collides on key-order permutations", () => {
    expect(hashToolInput({ a: 1, b: 2 })).toBe(hashToolInput({ b: 2, a: 1 }));
  });

  it("differs on different values", () => {
    expect(hashToolInput({ a: 1 })).not.toBe(hashToolInput({ a: 2 }));
  });

  it("handles arrays + nested objects deterministically", () => {
    const a = { xs: [1, 2, { k: "v" }] };
    const b = { xs: [1, 2, { k: "v" }] };
    expect(hashToolInput(a)).toBe(hashToolInput(b));
  });

  it("handles Date stably (ISO normalization)", () => {
    const d = new Date("2026-05-09T12:00:00Z");
    expect(hashToolInput({ t: d })).toBe(hashToolInput({ t: d }));
    // Same instant via different constructor call → same hash.
    expect(hashToolInput({ t: new Date("2026-05-09T12:00:00Z") })).toBe(
      hashToolInput({ t: new Date(Date.UTC(2026, 4, 9, 12, 0, 0)) }),
    );
  });

  it("handles BigInt without throwing", () => {
    expect(hashToolInput({ n: 1n })).toBe(hashToolInput({ n: 1n }));
    expect(hashToolInput({ n: 1n })).not.toBe(hashToolInput({ n: 2n }));
  });

  it("handles circular references without throwing", () => {
    const a: Record<string, unknown> = { name: "loop" };
    a.self = a;
    expect(() => hashToolInput(a)).not.toThrow();
    // Two separate objects with the same shape + cycle should hash equal.
    const b: Record<string, unknown> = { name: "loop" };
    b.self = b;
    expect(hashToolInput(a)).toBe(hashToolInput(b));
  });

  it("handles undefined + null without throwing", () => {
    expect(() => hashToolInput(undefined)).not.toThrow();
    expect(() => hashToolInput(null)).not.toThrow();
    expect(() => hashToolInput({ x: undefined })).not.toThrow();
  });
});

describe("loop-detector — observe-only at STUCK_THRESHOLD", () => {
  it("records warning at STUCK_THRESHOLD without denying", async () => {
    const ctx = makeCtx();
    const payload = makePayload(ctx, "query_kg", { q: "foo" });

    let r = {} as Awaited<ReturnType<typeof loopDetectorHook>>;
    for (let i = 0; i < STUCK_THRESHOLD; i++) {
      r = await loopDetectorHook(payload);
    }

    // No deny up to STUCK_THRESHOLD — observe-only.
    expect("hookSpecificOutput" in r ? r.hookSpecificOutput : undefined).toBeUndefined();
    const warnings = ctx.scratchpad.get(LOOP_WARNINGS_KEY) as LoopWarning[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      toolId: "query_kg",
      occurrences: STUCK_THRESHOLD,
    });
  });

  it("does not warn before STUCK_THRESHOLD", async () => {
    const ctx = makeCtx();
    const payload = makePayload(ctx, "query_kg", { q: "foo" });

    for (let i = 0; i < STUCK_THRESHOLD - 1; i++) {
      await loopDetectorHook(payload);
    }
    expect(ctx.scratchpad.get(LOOP_WARNINGS_KEY)).toBeUndefined();
  });
});

describe("loop-detector — hard deny at HARD_DENY_THRESHOLD", () => {
  it("returns deny decision after HARD_DENY_THRESHOLD repeats", async () => {
    const ctx = makeCtx();
    const payload = makePayload(ctx, "query_kg", { q: "foo" });

    let final: Awaited<ReturnType<typeof loopDetectorHook>> = {};
    for (let i = 0; i < HARD_DENY_THRESHOLD; i++) {
      final = await loopDetectorHook(payload);
    }
    expect("hookSpecificOutput" in final && final.hookSpecificOutput).toMatchObject({
      hookEventName: "pre_tool",
      permissionDecision: "deny",
    });
  });

  it("different args do NOT count toward the same threshold", async () => {
    const ctx = makeCtx();
    for (let i = 0; i < HARD_DENY_THRESHOLD; i++) {
      const r = await loopDetectorHook(
        makePayload(ctx, "query_kg", { q: `query-${i}` }),
      );
      // Each call has a unique hash so no deny ever fires.
      expect("hookSpecificOutput" in r ? r.hookSpecificOutput : undefined).toBeUndefined();
    }
  });
});

describe("loop-detector — bounded scratchpad", () => {
  it("recent_tool_calls is capped at RECENT_WINDOW", async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 25; i++) {
      await loopDetectorHook(makePayload(ctx, "t", { i }));
    }
    const recent = ctx.scratchpad.get(RECENT_TOOL_CALLS_KEY) as RecentToolCall[];
    expect(recent.length).toBeLessThanOrEqual(10);
  });
});
