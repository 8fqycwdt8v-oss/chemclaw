// Phase 4C: dedicated tests for the matcher regex gate added in Phase 4A.
//
// The dispatcher's matcher contract (see lifecycle.ts:144-148) is:
//   if (hook.matcher) {
//     if (!opts.matcherTarget || !hook.matcher.test(opts.matcherTarget)) continue;
//   }
//
// So a hook with a matcher fires iff matcherTarget is supplied AND the regex
// matches it. A hook without a matcher always fires. A hook with a matcher
// but no matcherTarget on dispatch is SKIPPED — there is no implicit match.
//
// These tests lock that contract; if the gate's semantics change, this file
// should fail loudly so the change is intentional.
import { describe, it, expect, vi } from "vitest";
import { Lifecycle } from "../../src/core/lifecycle.js";
import type { ToolContext } from "../../src/core/types.js";

const ctx: ToolContext = {
  userEntraId: "u",
  scratchpad: new Map(),
  seenFactIds: new Set(),
};

describe("Lifecycle matcher filters callback execution", () => {
  it("only fires the callback when matcher.test(matcherTarget) is true", async () => {
    const lc = new Lifecycle();
    const writeOnly = vi.fn().mockResolvedValue({});
    const allTools = vi.fn().mockResolvedValue({});
    lc.on("pre_tool", "write-only", writeOnly, { matcher: "Write|Edit" });
    lc.on("pre_tool", "all-tools", allTools);

    // matcher target "Read" — should NOT fire write-only.
    await lc.dispatch(
      "pre_tool",
      { ctx, toolId: "Read", input: {} },
      { matcherTarget: "Read" },
    );
    expect(writeOnly).not.toHaveBeenCalled();
    expect(allTools).toHaveBeenCalledTimes(1);

    // matcher target "Write" — SHOULD fire write-only.
    await lc.dispatch(
      "pre_tool",
      { ctx, toolId: "Write", input: {} },
      { matcherTarget: "Write" },
    );
    expect(writeOnly).toHaveBeenCalledTimes(1);
    expect(allTools).toHaveBeenCalledTimes(2);
  });

  it("hooks without a matcher always fire", async () => {
    const lc = new Lifecycle();
    const fn = vi.fn().mockResolvedValue({});
    lc.on("pre_tool", "always", fn);
    await lc.dispatch("pre_tool", { ctx, toolId: "anything", input: {} }, {});
    expect(fn).toHaveBeenCalled();
  });

  it("matcher set + matcherTarget absent → hook is SKIPPED (no implicit match)", async () => {
    // Confirms the dispatcher's documented behaviour: a hook that opts into
    // matcher gating only runs when a target is supplied. Absence of a
    // target is treated as "no match" — the hook does not fire.
    const lc = new Lifecycle();
    const fn = vi.fn().mockResolvedValue({});
    lc.on("pre_tool", "matched", fn, { matcher: "Bash" });
    await lc.dispatch("pre_tool", { ctx, toolId: "x", input: {} });
    expect(fn).not.toHaveBeenCalled();
  });

  it("regex matcher: 'Write|Edit|Delete' alternation pattern", async () => {
    const lc = new Lifecycle();
    const fn = vi.fn().mockResolvedValue({});
    lc.on("pre_tool", "fileops", fn, { matcher: "Write|Edit|Delete" });
    for (const t of ["Read", "Write", "Edit", "Delete", "Glob", "Bash"]) {
      await lc.dispatch(
        "pre_tool",
        { ctx, toolId: t, input: {} },
        { matcherTarget: t },
      );
    }
    // Should fire 3 times (Write, Edit, Delete).
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("MCP-shape matcher '^mcp__' fires only on mcp__ prefixed tools", async () => {
    const lc = new Lifecycle();
    const fn = vi.fn().mockResolvedValue({});
    lc.on("pre_tool", "mcp", fn, { matcher: "^mcp__" });
    for (const t of ["Read", "mcp__github__list", "Bash", "mcp__slack__post"]) {
      await lc.dispatch(
        "pre_tool",
        { ctx, toolId: t, input: {} },
        { matcherTarget: t },
      );
    }
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
