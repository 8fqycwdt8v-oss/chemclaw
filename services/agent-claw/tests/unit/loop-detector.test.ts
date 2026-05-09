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
