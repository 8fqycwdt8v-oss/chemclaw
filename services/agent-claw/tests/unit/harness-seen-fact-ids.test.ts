// End-to-end harness integration test for seenFactIds anti-fabrication flow.
//
// Uses StubLlmProvider to drive the harness through:
//   1. query_kg call → 3 fact_ids in seenFactIds
//   2. propose_hypothesis with a SEEN fact_id → succeeds
//   3. propose_hypothesis with an UNSEEN fact_id → agent gets error, re-plans
//
// No real DB or MCP services involved.

import { describe, it, expect, vi, afterEach } from "vitest";
import { runHarness } from "../../src/core/harness.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { Budget } from "../../src/core/budget.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { defineTool } from "../../src/tools/tool.js";
import { z } from "zod";
import { antiFabricationHook } from "../../src/core/hooks/anti-fabrication.js";
import { initScratchHook } from "../../src/core/hooks/init-scratch.js";
import { makeCtx } from "../helpers/make-ctx.js";
import type { ToolContext } from "../../src/core/types.js";

// ---------- Fake fact UUIDs --------------------------------------------------

const FACT_1 = "aaaaaaaa-1111-1111-1111-111111111111";
const FACT_2 = "bbbbbbbb-2222-2222-2222-222222222222";
const FACT_3 = "cccccccc-3333-3333-3333-333333333333";
const UNSEEN = "dddddddd-9999-9999-9999-999999999999";

// ---------- Stub tools -------------------------------------------------------

/**
 * Stub query_kg that returns 3 facts.
 * post_tool hook will harvest their fact_ids.
 */
const stubQueryKg = defineTool({
  id: "query_kg",
  description: "Stub KG query",
  inputSchema: z.object({ entity: z.object({ id_value: z.string() }) }),
  outputSchema: z.object({ facts: z.array(z.object({ fact_id: z.string() })) }),
  execute: async () => ({
    facts: [{ fact_id: FACT_1 }, { fact_id: FACT_2 }, { fact_id: FACT_3 }],
  }),
});

/**
 * Stub propose_hypothesis that enforces the anti-fabrication guard.
 */
const stubProposeHypothesis = defineTool({
  id: "propose_hypothesis",
  description: "Stub hypothesis proposal",
  inputSchema: z.object({ cited_fact_ids: z.array(z.string()) }),
  outputSchema: z.object({ hypothesis_id: z.string(), ok: z.boolean() }),
  execute: async (ctx: ToolContext, input: { cited_fact_ids: string[] }) => {
    const seen =
      (ctx.scratchpad.get("seenFactIds") as Set<string> | undefined) ??
      new Set<string>();
    const unseen = input.cited_fact_ids.filter((f) => !seen.has(f));
    if (unseen.length > 0) {
      throw new Error(
        `propose_hypothesis rejected: cited_fact_ids not seen: ${unseen.join(", ")}`,
      );
    }
    return { hypothesis_id: "eeeeeeee-0000-0000-0000-000000000001", ok: true };
  },
});

// ---------- Lifecycle with anti-fabrication hooks ----------------------------

function makeLifecycle(): Lifecycle {
  const lifecycle = new Lifecycle();
  lifecycle.on("pre_turn", "init-scratch", initScratchHook);
  lifecycle.on("post_tool", "anti-fabrication", antiFabricationHook);
  return lifecycle;
}

// ---------- Tests ------------------------------------------------------------

describe("harness seenFactIds integration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("query_kg populates seenFactIds with 3 fact_ids, then text stop", async () => {
    const llm = new StubLlmProvider();
    llm
      .enqueueToolCall("query_kg", { entity: { id_value: "rxn-1" } })
      .enqueueText("I found 3 facts about this reaction.");

    const ctx = makeCtx();
    const result = await runHarness({
      messages: [{ role: "user", content: "Tell me about rxn-1" }],
      tools: [stubQueryKg, stubProposeHypothesis],
      llm,
      budget: new Budget({ maxSteps: 10 }),
      lifecycle: makeLifecycle(),
      ctx,
    });

    expect(result.finishReason).toBe("stop");
    // After pre_turn and one post_tool call, seenFactIds should have all 3 facts.
    const seen = ctx.scratchpad.get("seenFactIds") as Set<string>;
    expect(seen.has(FACT_1)).toBe(true);
    expect(seen.has(FACT_2)).toBe(true);
    expect(seen.has(FACT_3)).toBe(true);
    expect(seen.size).toBe(3);
  });

  it("propose_hypothesis with a seen fact_id succeeds", async () => {
    const llm = new StubLlmProvider();
    llm
      .enqueueToolCall("query_kg", { entity: { id_value: "rxn-1" } })
      .enqueueToolCall("propose_hypothesis", { cited_fact_ids: [FACT_1] })
      .enqueueText("Hypothesis proposed successfully.");

    const ctx = makeCtx();
    const result = await runHarness({
      messages: [{ role: "user", content: "Propose a hypothesis" }],
      tools: [stubQueryKg, stubProposeHypothesis],
      llm,
      budget: new Budget({ maxSteps: 10 }),
      lifecycle: makeLifecycle(),
      ctx,
    });

    expect(result.finishReason).toBe("stop");
  });

  it("propose_hypothesis with an unseen fact_id throws, propagating to harness", async () => {
    const llm = new StubLlmProvider();
    // Skip query_kg — go straight to propose with an unseen fact_id.
    llm
      .enqueueToolCall("propose_hypothesis", { cited_fact_ids: [UNSEEN] });

    const ctx = makeCtx();
    await expect(
      runHarness({
        messages: [{ role: "user", content: "Propose a hypothesis" }],
        tools: [stubQueryKg, stubProposeHypothesis],
        llm,
        budget: new Budget({ maxSteps: 10 }),
        lifecycle: makeLifecycle(),
        ctx,
      }),
    ).rejects.toThrow(/cited_fact_ids not seen/);
  });
});
