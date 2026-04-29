// Phase 3 — pre_compact / post_compact end-to-end integration test.
//
// Drives a real runHarness invocation backed by the production YAML hook
// loader (so the compact-window hook is registered exactly the way it is
// in production). The LLM stub reports prompt-token usage that crosses the
// 60% compaction threshold mid-turn; we assert that pre_compact and
// post_compact fire, that the message list shrinks across the boundary,
// and that the turn produces a non-empty final text.
//
// Companion to all-hooks-fire.test.ts (Phase 1C), which exercised the
// other four lifecycle points.

import { describe, it, expect, vi } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { loadHooks } from "../../src/core/hook-loader.js";
import { runHarness } from "../../src/core/harness.js";
import { Budget } from "../../src/core/budget.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { defineTool } from "../../src/tools/tool.js";
import { SkillLoader } from "../../src/core/skills.js";
import { mockHookDeps } from "../helpers/mocks.js";
import type { Message, ToolContext } from "../../src/core/types.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const hooksDir = resolve(repoRoot, "hooks");

describe("pre_compact end-to-end (integration)", () => {
  it("fires pre_compact + post_compact mid-turn and shrinks the message window", async () => {
    // Build a real Lifecycle from on-disk YAML — same as production. Pass a
    // real SkillLoader so apply-skills doesn't trip the throwing-Proxy stub
    // and an LLM stub the compact-window hook can use for its synopsis call.
    const lc = new Lifecycle();
    const skillLoader = new SkillLoader();

    // The compact-window hook needs a real LLM to call completeJson on
    // (the throwing Proxy would blow up the moment compact() invokes it).
    // Reuse the same StubLlmProvider that drives the harness — it returns
    // {} from completeJson by default, which compact() handles via its
    // truncate-on-empty fallback.
    const llm = new StubLlmProvider();

    await loadHooks(
      lc,
      mockHookDeps({
        skillLoader,
        llm,
        // Token budget for the compactor's own internal book-keeping; the
        // trigger decision lives on Budget now.
        tokenBudget: 5_000,
      }),
      hooksDir,
    );

    const dispatchSpy = vi.spyOn(lc, "dispatch");

    // A tool the LLM "calls" twice so we accumulate large tool results in
    // the message window. compactor.ts collapses older turns into a single
    // synopsis system message so the post-compaction message list is
    // strictly shorter than the pre-compaction one.
    const bigTool = defineTool({
      id: "search_knowledge",
      description: "Search the knowledge graph (test stub).",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ payload: z.string() }),
      execute: async () => ({ payload: "x".repeat(2_000) }),
    });

    // Three steps: tool_call → tool_call → tool_call → text.
    // Each LLM call reports promptTokens=2_000, so usage hits 6_000 after
    // the third step (== 60% of 10_000) and pre_compact fires.
    llm
      .enqueueToolCall(
        "search_knowledge",
        { query: "a" },
        { promptTokens: 2_000, completionTokens: 10 },
      )
      .enqueueToolCall(
        "search_knowledge",
        { query: "b" },
        { promptTokens: 2_000, completionTokens: 10 },
      )
      .enqueueToolCall(
        "search_knowledge",
        { query: "c" },
        { promptTokens: 2_000, completionTokens: 10 },
      )
      .enqueueText("final answer", { promptTokens: 100, completionTokens: 10 });

    const ctx: ToolContext = {
      userEntraId: "test@example.com",
      scratchpad: new Map<string, unknown>(),
      seenFactIds: new Set<string>(),
    };

    const messages: Message[] = [
      { role: "system", content: "you are an agent" },
      { role: "user", content: "do the thing" },
    ];

    const budget = new Budget({
      maxSteps: 10,
      maxPromptTokens: 10_000,
      compactionThreshold: 0.6,
    });

    const result = await runHarness({
      messages,
      tools: [bigTool],
      llm,
      budget,
      lifecycle: lc,
      ctx,
    });

    // pre_compact + post_compact both fired.
    const points = dispatchSpy.mock.calls.map((c) => c[0] as string);
    expect(points).toContain("pre_compact");
    expect(points).toContain("post_compact");

    // The compact-window hook mutated payload.messages in-place, so the
    // message array we passed in is now shorter than its pre-compact peak.
    // (Pre-compact peak was system + user + 3× assistant + 3× tool = 8;
    // post-compact: system + synopsis + recent 3 = 5.)
    const preCompactCall = dispatchSpy.mock.calls.find(
      (c) => c[0] === "pre_compact",
    );
    expect(preCompactCall).toBeDefined();
    const postCompactCall = dispatchSpy.mock.calls.find(
      (c) => c[0] === "post_compact",
    );
    expect(postCompactCall).toBeDefined();
    const postPayload = postCompactCall![1] as {
      pre_tokens: number;
      post_tokens: number;
    };
    expect(postPayload.post_tokens).toBeLessThan(postPayload.pre_tokens);

    // The harness still produced a final text after the compaction.
    expect(result.text).toBe("final answer");
    expect(result.finishReason).toBe("stop");
  });
});
