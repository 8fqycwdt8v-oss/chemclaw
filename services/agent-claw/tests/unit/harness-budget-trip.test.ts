// Test: token / step budgets stop the harness loop with the right finishReason.
//
// BACKLOG'd test gap from the 2026-05-08 deep review: token-budget enforcement.
// Existing budget-session.test.ts unit-tests Budget.consumeStep directly; this
// file drives the FULL runHarness loop with a budget that's tight enough to
// trip mid-loop, so a regression that swapped the BudgetExceededError catch
// for a generic Error rethrow (or that forgot to set finishReason in the
// catch) surfaces here instead of silently letting a runaway turn keep going.
//
// Three asserts, mapping to the three caps:
//   (a) maxSteps cap → finishReason "max_steps", no error thrown.
//   (b) maxPromptTokens cap → BudgetExceededError thrown with dim "prompt_tokens".
//   (c) Cross-turn (session) cap → SessionBudgetExceededError thrown.

import { describe, it, expect } from "vitest";
import { runHarness } from "../../src/core/harness.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import {
  Budget,
  BudgetExceededError,
  SessionBudgetExceededError,
} from "../../src/core/budget.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { defineTool } from "../../src/tools/tool.js";
import { z } from "zod";
import { makeCtx } from "../helpers/make-ctx.js";

const echoTool = defineTool({
  id: "echo",
  description: "echo input back",
  inputSchema: z.object({ s: z.string() }),
  outputSchema: z.object({ s: z.string() }),
  execute: async (_ctx, input: { s: string }) => ({ s: input.s }),
});

describe("harness budget trip", () => {
  it("(a) maxSteps cap — loop stops with finishReason 'max_steps' and no throw", async () => {
    const llm = new StubLlmProvider();
    // Enqueue a tool_call → text loop that would run forever if the cap
    // didn't fire. Each tool_call consumes one step; the Budget's
    // isStepCapReached check stops the loop before the next LLM call.
    for (let i = 0; i < 10; i++) {
      llm.enqueueToolCall("echo", { s: `iter-${i}` });
    }
    llm.enqueueText("done");

    const result = await runHarness({
      messages: [{ role: "user", content: "loop please" }],
      tools: [echoTool],
      llm,
      budget: new Budget({ maxSteps: 3 }),
      lifecycle: new Lifecycle(),
      ctx: makeCtx(),
    });
    expect(result.finishReason).toBe("max_steps");
  });

  it("(b) maxPromptTokens cap — throws BudgetExceededError tagged 'prompt_tokens'", async () => {
    const llm = new StubLlmProvider();
    // Single step reports 600 prompt tokens against a 500 cap → consumeStep
    // throws on first call. compactionThreshold is set above 1.0 so
    // shouldCompact() never trips and silently resets _promptTokens via
    // estimateTokenCount(messages) (which would otherwise mask a
    // budget-trip regression).
    llm.enqueueToolCall(
      "echo",
      { s: "first" },
      { promptTokens: 600, completionTokens: 5 },
    );
    llm.enqueueText("never reached");

    const promise = runHarness({
      messages: [{ role: "user", content: "go" }],
      tools: [echoTool],
      llm,
      budget: new Budget({
        maxSteps: 100,
        maxPromptTokens: 500,
        compactionThreshold: 10, // disable mid-turn compaction reset
      }),
      lifecycle: new Lifecycle(),
      ctx: makeCtx(),
    });

    await expect(promise).rejects.toThrowError(BudgetExceededError);
    await expect(promise).rejects.toMatchObject({ dimension: "prompt_tokens" });
  });

  it("(c) cross-turn session cap — throws SessionBudgetExceededError", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueText(
      "expensive turn",
      { promptTokens: 600, completionTokens: 50 },
    );

    const promise = runHarness({
      messages: [{ role: "user", content: "expensive please" }],
      tools: [],
      llm,
      // Per-turn caps comfortable; the session input cap is 1k and we've
      // already used 500 in prior turns, so this turn's 600-token usage
      // overshoots the lifetime cap by 100.
      budget: new Budget({
        maxSteps: 100,
        maxPromptTokens: 10_000,
        maxCompletionTokens: 10_000,
        session: {
          inputUsed: 500,
          outputUsed: 0,
          inputCap: 1_000,
          outputCap: 5_000,
        },
      }),
      lifecycle: new Lifecycle(),
      ctx: makeCtx(),
    });

    await expect(promise).rejects.toThrowError(SessionBudgetExceededError);
  });
});
