// Phase 4C: dedicated tests for decision aggregation + AbortSignal delivery.
//
// Two contracts are locked here:
//   1. mostRestrictive() implements deny>defer>ask>allow precedence with
//      `undefined` meaning "no opinion" (returns the right-hand value).
//   2. Lifecycle.dispatch aggregates permission decisions across hooks at
//      the same point using mostRestrictive(); reason follows whichever
//      hook upgraded the decision (NOT the last); updatedInput is captured
//      with last-write-wins; { async: true } returns are excluded from
//      aggregation; zero hooks → an empty result shape.
//   3. Hook callbacks receive an AbortSignal in opts.signal — we don't
//      assert the timeout fires (vitest fake-timer + AbortController has
//      portability caveats), but we verify the signal is wired through.
import { describe, it, expect } from "vitest";
import { Lifecycle } from "../../src/core/lifecycle.js";
import type { ToolContext } from "../../src/core/types.js";
import {
  mostRestrictive,
  type PermissionDecision,
} from "../../src/core/hook-output.js";

const ctx: ToolContext = {
  userEntraId: "u",
  scratchpad: new Map(),
  seenFactIds: new Set(),
};

describe("mostRestrictive precedence", () => {
  it("deny > defer > ask > allow", () => {
    expect(mostRestrictive(undefined, "allow")).toBe("allow");
    expect(mostRestrictive("allow", "ask")).toBe("ask");
    expect(mostRestrictive("ask", "defer")).toBe("defer");
    expect(mostRestrictive("defer", "deny")).toBe("deny");
    expect(mostRestrictive("deny", "allow")).toBe("deny");
    expect(mostRestrictive("deny", "ask")).toBe("deny");
    expect(mostRestrictive("deny", "defer")).toBe("deny");
    expect(mostRestrictive("defer", "ask")).toBe("defer");
    expect(mostRestrictive("ask", "allow")).toBe("ask");
  });

  it("returns left when both equal", () => {
    expect(mostRestrictive("allow", "allow")).toBe("allow");
    expect(mostRestrictive("deny", "deny")).toBe("deny");
  });
});

describe("Lifecycle.dispatch aggregates decisions across hooks at the same point", () => {
  it("3 hooks (allow, deny, allow) → final decision = deny", async () => {
    const lc = new Lifecycle();
    lc.on("pre_tool", "a", async () => ({
      hookSpecificOutput: {
        hookEventName: "pre_tool",
        permissionDecision: "allow" as PermissionDecision,
      },
    }));
    lc.on("pre_tool", "b", async () => ({
      hookSpecificOutput: {
        hookEventName: "pre_tool",
        permissionDecision: "deny" as PermissionDecision,
        permissionDecisionReason: "blocked by policy",
      },
    }));
    lc.on("pre_tool", "c", async () => ({
      hookSpecificOutput: {
        hookEventName: "pre_tool",
        permissionDecision: "allow" as PermissionDecision,
      },
    }));

    const result = await lc.dispatch("pre_tool", {
      ctx,
      toolId: "x",
      input: {},
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("blocked by policy");
  });

  it("captures the FIRST deny's reason, not the last (later allow doesn't overwrite)", async () => {
    // Once the aggregate decision becomes "deny", a later "allow" can't
    // downgrade it (mostRestrictive returns "deny"), so the reason set by
    // the first deny must survive.
    const lc = new Lifecycle();
    lc.on("pre_tool", "a", async () => ({
      hookSpecificOutput: {
        hookEventName: "pre_tool",
        permissionDecision: "deny" as PermissionDecision,
        permissionDecisionReason: "first",
      },
    }));
    lc.on("pre_tool", "b", async () => ({
      hookSpecificOutput: {
        hookEventName: "pre_tool",
        permissionDecision: "allow" as PermissionDecision,
      },
    }));
    const result = await lc.dispatch("pre_tool", {
      ctx,
      toolId: "x",
      input: {},
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("first");
  });

  it("captures updatedInput from the last hook that returns it (last-write-wins)", async () => {
    const lc = new Lifecycle();
    lc.on("pre_tool", "a", async () => ({
      hookSpecificOutput: {
        hookEventName: "pre_tool",
        permissionDecision: "allow" as PermissionDecision,
        updatedInput: { from: "a", path: "/etc/foo" },
      },
    }));
    lc.on("pre_tool", "b", async () => ({
      hookSpecificOutput: {
        hookEventName: "pre_tool",
        permissionDecision: "allow" as PermissionDecision,
        updatedInput: { from: "b", path: "/sandbox/foo" },
      },
    }));
    const result = await lc.dispatch("pre_tool", {
      ctx,
      toolId: "x",
      input: {},
    });
    expect(result.decision).toBe("allow");
    expect(result.updatedInput).toEqual({ from: "b", path: "/sandbox/foo" });
  });

  it("async-true hooks do NOT contribute to decision aggregation", async () => {
    const lc = new Lifecycle();
    lc.on("pre_tool", "async-noisy", async () => ({
      async: true,
      asyncTimeout: 500,
    }));
    lc.on("pre_tool", "sync-allow", async () => ({
      hookSpecificOutput: {
        hookEventName: "pre_tool",
        permissionDecision: "allow" as PermissionDecision,
      },
    }));
    const result = await lc.dispatch("pre_tool", {
      ctx,
      toolId: "x",
      input: {},
    });
    expect(result.decision).toBe("allow");
  });

  it("zero hooks → decision/reason/updatedInput are all undefined", async () => {
    const lc = new Lifecycle();
    const result = await lc.dispatch("pre_tool", {
      ctx,
      toolId: "x",
      input: {},
    });
    expect(result.decision).toBeUndefined();
    expect(result.reason).toBeUndefined();
    expect(result.updatedInput).toBeUndefined();
  });

  it("ask + defer → defer wins (defer > ask)", async () => {
    const lc = new Lifecycle();
    lc.on("pre_tool", "a", async () => ({
      hookSpecificOutput: {
        hookEventName: "pre_tool",
        permissionDecision: "ask" as PermissionDecision,
        permissionDecisionReason: "needs confirmation",
      },
    }));
    lc.on("pre_tool", "b", async () => ({
      hookSpecificOutput: {
        hookEventName: "pre_tool",
        permissionDecision: "defer" as PermissionDecision,
        permissionDecisionReason: "deferred to permission system",
      },
    }));
    const result = await lc.dispatch("pre_tool", {
      ctx,
      toolId: "x",
      input: {},
    });
    expect(result.decision).toBe("defer");
    expect(result.reason).toBe("deferred to permission system");
  });
});

describe("Lifecycle AbortSignal", () => {
  it("hook receives an AbortSignal in options", async () => {
    const lc = new Lifecycle();
    let receivedSignal: AbortSignal | undefined;
    lc.on("pre_tool", "sig-aware", async (_p, _id, opts) => {
      receivedSignal = opts.signal;
      return {};
    });
    await lc.dispatch("pre_tool", { ctx, toolId: "x", input: {} });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    // The signal is fresh per dispatch and not aborted on entry.
    expect(receivedSignal?.aborted).toBe(false);
  });

  // Don't test the timeout firing — vitest's fake-timer interaction with
  // AbortController has compatibility caveats; the timeout mechanism is
  // verified indirectly by the existing 60s default working in production.
});
