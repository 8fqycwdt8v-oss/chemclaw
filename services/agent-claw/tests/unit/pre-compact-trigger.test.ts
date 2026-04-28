// Phase 3 — pre_compact / post_compact dispatch from runHarness when the
// prompt-token usage crosses the configured compaction threshold.
//
// Today the hook point is declared and the compact-window hook is
// registered, but runHarness has zero dispatch sites for pre_compact and
// no post_compact hook point at all. These tests pin down the contract
// that crossing the threshold fires both points (with the message list
// carried through pre_compact's payload), and that staying below the
// threshold fires neither.

import { describe, it, expect, vi } from "vitest";
import { runHarness } from "../../src/core/harness.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { Budget } from "../../src/core/budget.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import type { Message, ToolContext } from "../../src/core/types.js";

describe("pre_compact triggers when token usage > threshold", () => {
  it("fires pre_compact + post_compact when usage crosses 60% of maxPromptTokens", async () => {
    const lc = new Lifecycle();
    const dispatchSpy = vi.spyOn(lc, "dispatch");

    // 10_000 prompt-token cap with 0.60 threshold = compact at >= 6_000.
    // One step reporting 7_000 prompt tokens crosses the threshold and the
    // harness fires pre_compact / post_compact between consumeStep and the
    // text-terminator branch.
    const budget = new Budget({
      maxSteps: 5,
      maxPromptTokens: 10_000,
      compactionThreshold: 0.6,
    });
    const llm = new StubLlmProvider().enqueueText("answer", {
      promptTokens: 7_000,
      completionTokens: 10,
    });

    const ctx: ToolContext = {
      userEntraId: "u",
      scratchpad: new Map(),
      seenFactIds: new Set(),
    };

    await runHarness({
      messages: [{ role: "user", content: "hi" }] as Message[],
      tools: [],
      llm,
      budget,
      lifecycle: lc,
      ctx,
    });

    const points = dispatchSpy.mock.calls.map((c) => c[0]);
    expect(points).toContain("pre_compact");
    expect(points).toContain("post_compact");

    // pre_compact payload carries the trigger reason and pre_tokens count.
    const preCompactCall = dispatchSpy.mock.calls.find(
      (c) => c[0] === "pre_compact",
    );
    expect(preCompactCall).toBeDefined();
    const prePayload = preCompactCall![1] as { trigger: string; pre_tokens: number };
    expect(prePayload.trigger).toBe("auto");
    expect(prePayload.pre_tokens).toBe(7_000);
  });

  it("does NOT fire pre_compact when usage stays below threshold", async () => {
    const lc = new Lifecycle();
    const dispatchSpy = vi.spyOn(lc, "dispatch");
    const budget = new Budget({
      maxSteps: 5,
      maxPromptTokens: 100_000,
      compactionThreshold: 0.6,
    });
    // Usage stays well below 60_000.
    const llm = new StubLlmProvider().enqueueText("answer", {
      promptTokens: 1_000,
      completionTokens: 10,
    });

    const ctx: ToolContext = {
      userEntraId: "u",
      scratchpad: new Map(),
      seenFactIds: new Set(),
    };

    await runHarness({
      messages: [{ role: "user", content: "hi" }] as Message[],
      tools: [],
      llm,
      budget,
      lifecycle: lc,
      ctx,
    });

    const points = dispatchSpy.mock.calls.map((c) => c[0]);
    expect(points).not.toContain("pre_compact");
    expect(points).not.toContain("post_compact");
  });
});
