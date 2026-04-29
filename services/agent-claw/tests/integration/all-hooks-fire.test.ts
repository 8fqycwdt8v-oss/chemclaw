// Phase 1C — integration test that locks in the invariant established by
// Phases 1A and 1B: every active lifecycle hook point fires on a real
// runHarness invocation driven by the YAML-loader-populated production
// lifecycle.
//
// Phases 1A/1B verified pieces in isolation: 1A locked the YAML loader as
// the single source of truth for hook registration (9 hooks at the right
// points), 1B made routes + sub-agents consume the same global lifecycle.
// Neither exercised the integrated path — does runHarness actually dispatch
// pre_turn → pre_tool → post_tool → post_turn end-to-end? This test does.
//
// Scope: pre_turn, pre_tool, post_tool, post_turn. pre_compact / post_compact
// are intentionally not exercised here — Phase 3 of the rebuild plan adds the
// compaction trigger logic + the corresponding test.

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

describe("all hooks fire on a real harness turn (integration)", () => {
  it("dispatches pre_turn, pre_tool, post_tool, post_turn at least once each in order", async () => {
    // 1. Build a real Lifecycle from the on-disk YAML — the same way
    //    production starts up. Pass a real SkillLoader (no skills loaded;
    //    activeIds is empty so apply-skills is a no-op) so the throwing-
    //    Proxy default doesn't fire when pre_turn runs.
    const lc = new Lifecycle();
    const skillLoader = new SkillLoader();
    await loadHooks(lc, mockHookDeps({ skillLoader }), hooksDir);

    // 2. Spy on dispatch to capture which hook points fire and in what order.
    const dispatchSpy = vi.spyOn(lc, "dispatch");

    // 3. Tool stub the LLM is going to "call".
    const searchKnowledge = defineTool({
      id: "search_knowledge",
      description: "Search the knowledge graph (test stub).",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ ok: z.literal(true) }),
      execute: async () => ({ ok: true }),
    });

    // 4. LLM stub: first call returns a tool_call, second call returns text.
    //    Result: one tool step (firing pre_tool + post_tool inside stepOnce)
    //    and one final text step. The harness fires pre_turn before the loop
    //    and post_turn after the loop exits.
    const llm = new StubLlmProvider()
      .enqueueToolCall("search_knowledge", { query: "hi" })
      .enqueueText("done");

    const ctx: ToolContext = {
      userEntraId: "test@example.com",
      scratchpad: new Map<string, unknown>(),
      seenFactIds: new Set<string>(),
    };

    const messages: Message[] = [{ role: "user", content: "hi" }];

    await runHarness({
      messages,
      tools: [searchKnowledge],
      llm,
      budget: new Budget({ maxSteps: 3 }),
      lifecycle: lc,
      ctx,
    });

    // 5. Assertions — every active hook point fires at least once.
    const points = dispatchSpy.mock.calls.map((c) => c[0] as string);
    expect(points).toContain("pre_turn");
    expect(points).toContain("pre_tool");
    expect(points).toContain("post_tool");
    expect(points).toContain("post_turn");

    // Relative order: pre_turn < pre_tool < post_tool < post_turn. Catches
    // a future refactor that reorders dispatch sites incorrectly. We use
    // indexOf (first occurrence) since each point may fire more than once
    // in principle; the test only locks the first-occurrence order.
    const idxPreTurn = points.indexOf("pre_turn");
    const idxPreTool = points.indexOf("pre_tool");
    const idxPostTool = points.indexOf("post_tool");
    const idxPostTurn = points.indexOf("post_turn");
    expect(idxPreTurn).toBeLessThan(idxPreTool);
    expect(idxPreTool).toBeLessThan(idxPostTool);
    expect(idxPostTool).toBeLessThan(idxPostTurn);
  });
});
