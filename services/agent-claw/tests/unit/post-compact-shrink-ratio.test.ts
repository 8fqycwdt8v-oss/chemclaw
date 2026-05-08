// Test: post_compact fires with `post_tokens < pre_tokens` after the real
// compact-window hook chain runs.
//
// pre-compact-trigger.test.ts already pins down the dispatch trigger via a
// vi.spyOn(lifecycle, "dispatch") — but it doesn't register the actual
// compact-window hook, so it can't catch a regression where the hook
// stops compacting (silent no-op: the dispatch fires but post_tokens ==
// pre_tokens, and the harness re-trips shouldCompact() on the next step).
//
// This test registers the REAL compact-window hook with a stub LLM
// summarizer, drives the harness through the threshold-crossing branch,
// and asserts:
//   (a) post_compact fires AT LEAST once per turn that crosses 60% of
//       maxPromptTokens.
//   (b) The post_tokens reported in the payload is strictly less than the
//       pre_tokens — i.e., the compactor actually shrank the window
//       (shrinkRatio > 0).
//   (c) Subsequent steps see the compacted message list (the harness
//       reads from the same `messages` reference the hook mutated).

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { runHarness } from "../../src/core/harness.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { Budget } from "../../src/core/budget.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { registerCompactWindowHook } from "../../src/core/hooks/compact-window.js";
import { defineTool } from "../../src/tools/tool.js";
import type { Message, PostCompactPayload } from "../../src/core/types.js";
import { makeCtx } from "../helpers/make-ctx.js";

const echoTool = defineTool({
  id: "echo",
  description: "echo input back",
  inputSchema: z.object({ s: z.string() }),
  outputSchema: z.object({ s: z.string() }),
  execute: async (_ctx, input: { s: string }) => ({ s: input.s }),
});

describe("post_compact end-to-end with the real compact-window hook", () => {
  it("post_tokens < pre_tokens after compact-window mutates the message list", async () => {
    const lifecycle = new Lifecycle();

    // The summarizer LLM is the same stub — its only job is to return a
    // short synopsis when the compactor calls it.
    const llm = new StubLlmProvider();

    // Register the real hook. tokenBudget=10_000 mirrors the budget below
    // so the hook's compactor settings stay in sync with the harness'
    // shouldCompact() trigger.
    registerCompactWindowHook(lifecycle, {
      llm,
      tokenBudget: 10_000,
      triggerFraction: 0.6,
      keepRecent: 2,
    });

    // Capture the post_compact payload via a one-off telemetry hook.
    const postCompactPayloads: PostCompactPayload[] = [];
    lifecycle.on("post_compact", "telemetry", async (payload) => {
      postCompactPayloads.push(payload);
      return {};
    });

    // Build a long enough message list that estimateTokenCount() is high
    // pre-compaction and noticeably lower after the hook keeps only the
    // recent N + a synopsis. ~200 chars/turn ≈ 50 tokens; 30 turns ≈
    // 1_500 tokens — well above the 2-message keepRecent floor.
    const messages: Message[] = [{ role: "user", content: "kickoff" }];
    for (let i = 0; i < 30; i++) {
      messages.push({
        role: "assistant",
        content:
          `Long fillery assistant turn #${i} with enough text to push the ` +
          `estimated token count above the 60% threshold of the budget.`,
      });
      messages.push({
        role: "user",
        content: `Long fillery user turn #${i} that the compactor will fold ` +
                 `into the synopsis.`,
      });
    }

    // Enqueue order (StubLlmProvider is FIFO):
    //   (1) Step 1 — tool_call with high token usage to trip shouldCompact
    //       AFTER consumeStep records the usage.
    //   (2) The compact-window hook's summarizer call → short synopsis text.
    //   (3) Step 2 — text terminator that exits the loop.
    // Without the tool_call kicking step 1, a text-only step 1 would exit
    // the loop BEFORE post_compact fires and the test would silently green.
    llm.enqueueToolCall(
      "echo",
      { s: "kickoff" },
      { promptTokens: 7_000, completionTokens: 10 },
    );
    llm.enqueueText(
      "synopsis: discussed kickoff and follow-ups, no actions yet.",
      { promptTokens: 50, completionTokens: 30 },
    );
    llm.enqueueText("done", { promptTokens: 100, completionTokens: 10 });

    const dispatchSpy = vi.spyOn(lifecycle, "dispatch");

    await runHarness({
      messages,
      tools: [echoTool],
      llm,
      budget: new Budget({
        maxSteps: 5,
        maxPromptTokens: 10_000,
        compactionThreshold: 0.6,
      }),
      lifecycle,
      ctx: makeCtx(),
    });

    // (a) post_compact fired at least once.
    const points = dispatchSpy.mock.calls.map((c) => c[0]);
    expect(points).toContain("post_compact");
    expect(postCompactPayloads.length).toBeGreaterThanOrEqual(1);

    // (b) post_tokens strictly less than pre_tokens — the hook actually
    // shrank the window. A regression that swapped the in-place splice
    // for a no-op would leave post_tokens == pre_tokens, and this assert
    // would fire.
    const first = postCompactPayloads[0]!;
    expect(first.pre_tokens).toBeGreaterThan(first.post_tokens);
    expect(first.trigger).toBe("auto");

    // (c) The harness's `messages` array — the same reference the hook
    // mutated — is now strictly shorter than the pre-compaction window
    // by a wide margin, proving the splice took effect. Pre-compaction
    // we had 1 + 30*2 = 61 messages; the compactor keeps system +
    // synopsis + N=2 recent + the freshly-pushed step-1 tool_call
    // assistant + tool_result messages. Cap the upper bound at 10 so a
    // regression that removes only a handful of entries (e.g. a no-op
    // splice that drops one user turn but leaves the rest) trips this
    // assertion instead of silently passing.
    expect(messages.length).toBeLessThanOrEqual(10);
  });
});
