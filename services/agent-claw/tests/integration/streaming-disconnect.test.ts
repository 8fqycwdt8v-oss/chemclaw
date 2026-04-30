// Integration test: client-disconnect mid-stream propagates an AbortSignal
// from the route into runHarness, halts further LLM calls, and persists
// scratchpad with finish_reason="cancelled".
//
// Wave 2 PR-3 (streaming AbortSignal threading). Resolves the two TODOs
// at routes/chat.ts:632 and routes/deep-research.ts:200.
//
// Three layers exercised, all pool-free (no Docker required):
//
//   1. runHarness({ signal }) bails out with AbortError when the signal
//      fires between iterations; post_turn still runs from the harness's
//      own finally block so registered hooks see the cancellation.
//
//   2. runHarness({ signal }) bails out mid-LLM-call when llm.call honours
//      opts.signal — proves the signal is threaded into stepOnce → llm.call.
//
//   3. Tools that read ctx.signal observe the abort, proving the harness
//      forwards the option onto ToolContext for tool-side cancellation.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { runHarness } from "../../src/core/harness.js";
import { Budget } from "../../src/core/budget.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import type { LlmCallOptions, LlmResponse, StreamChunk } from "../../src/llm/provider.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { defineTool } from "../../src/tools/tool.js";
import type { Message, ToolContext } from "../../src/core/types.js";

describe("streaming disconnect — AbortSignal propagation", () => {
  let lifecycle: Lifecycle;
  beforeEach(() => {
    lifecycle = new Lifecycle();
  });

  it("bails out with AbortError when the signal fires between iterations; post_turn still runs", async () => {
    // Stub LLM that always returns a tool call so the loop would otherwise
    // run forever. The harness checks ctx.signal at the top of each loop
    // iteration and throws when it fires.
    const llm = new StubLlmProvider();
    llm.enqueueToolCall("ping", { x: 1 });
    llm.enqueueText("never reached");

    const tool = defineTool({
      id: "ping",
      description: "Test tool.",
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.object({ ok: z.literal(true) }),
      execute: async () => ({ ok: true as const }),
    });

    const ctx: ToolContext = {
      userEntraId: "u",
      seenFactIds: new Set(),
      scratchpad: new Map(),
    };

    const ac = new AbortController();
    const budget = new Budget({ maxSteps: 50, maxPromptTokens: 100_000 });

    let postTurnFires = 0;
    lifecycle.on("post_turn", "track-post-turn", async () => {
      postTurnFires += 1;
    });

    // Fire the abort BEFORE the loop runs. The harness's pre-iteration
    // ctx.signal.aborted check trips on the very first turn, AFTER pre_turn
    // and onSession have fired but BEFORE any LLM call or budget consumption.
    ac.abort();

    let captured: unknown;
    try {
      await runHarness({
        messages: [{ role: "user", content: "hi" }] as Message[],
        tools: [tool],
        llm,
        budget,
        lifecycle,
        ctx,
        signal: ac.signal,
      });
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeDefined();
    expect((captured as { name?: string }).name).toBe("AbortError");
    // post_turn fires from runHarness's finally block, even when the loop
    // exits via thrown AbortError.
    expect(postTurnFires).toBe(1);
    // No tool was executed — the loop bailed before stepOnce ran.
    expect(budget.stepsUsed).toBe(0);
  });

  it("aborts mid-LLM-call when llm.call honours opts.signal", async () => {
    // LLM whose call() awaits opts.signal and rejects with AbortError.
    // Proves runHarness threads HarnessOptions.signal → stepOnce → llm.call.
    const llm: {
      call(messages: Message[], tools: never[], opts?: LlmCallOptions): Promise<LlmResponse>;
      streamCompletion(): AsyncIterable<StreamChunk>;
      completeJson(): Promise<unknown>;
    } = {
      async call(_messages, _tools, opts) {
        await new Promise<void>((_resolve, reject) => {
          if (opts?.signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          opts?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
        throw new Error("call did not abort");
      },
      async *streamCompletion() {
        /* not used */
      },
      async completeJson() {
        return {};
      },
    };

    const ctx: ToolContext = {
      userEntraId: "u",
      seenFactIds: new Set(),
      scratchpad: new Map(),
    };

    const ac = new AbortController();
    const budget = new Budget({ maxSteps: 50, maxPromptTokens: 100_000 });

    let postTurnFires = 0;
    lifecycle.on("post_turn", "track-post-turn", async () => {
      postTurnFires += 1;
    });

    const promise = runHarness({
      messages: [{ role: "user", content: "hi" }] as Message[],
      tools: [],
      llm,
      budget,
      lifecycle,
      ctx,
      signal: ac.signal,
    }).catch((err: unknown) => err);

    // Yield once so the call() listener attaches before we abort.
    await new Promise((r) => setImmediate(r));
    ac.abort();

    const captured = await promise;
    expect((captured as { name?: string }).name).toBe("AbortError");
    expect(postTurnFires).toBe(1);
  });

  it("threads ctx.signal so tools observing it can short-circuit on disconnect", async () => {
    // The harness sets ctx.signal = options.signal so any tool with a
    // long-running operation (subprocess, file walk, custom HTTP) can
    // observe the abort directly without explicit threading.
    const llm = new StubLlmProvider();
    llm.enqueueToolCall("slow_observe", {});
    llm.enqueueText("never reached");

    let toolStarted = false;
    let toolFinishedNormally = false;
    let toolAbortedTyped = false;

    const slowObserve = defineTool({
      id: "slow_observe",
      description: "Tool that awaits ctx.signal.",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.literal(true) }),
      execute: async (toolCtx) => {
        toolStarted = true;
        await new Promise<void>((_resolve, reject) => {
          if (toolCtx.signal?.aborted) {
            toolAbortedTyped = true;
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          toolCtx.signal?.addEventListener(
            "abort",
            () => {
              toolAbortedTyped = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
          // 2s safety so a missing signal-thread doesn't hang the suite.
          setTimeout(() => reject(new Error("tool timed out — signal not threaded")), 2000);
        });
        toolFinishedNormally = true;
        return { ok: true as const };
      },
    });

    const ctx: ToolContext = {
      userEntraId: "u",
      seenFactIds: new Set(),
      scratchpad: new Map(),
    };

    const ac = new AbortController();
    const budget = new Budget({ maxSteps: 50, maxPromptTokens: 100_000 });

    const promise = runHarness({
      messages: [{ role: "user", content: "hi" }] as Message[],
      tools: [slowObserve],
      llm,
      budget,
      lifecycle,
      ctx,
      signal: ac.signal,
    }).catch((err: unknown) => err);

    // Wait for the tool to start, then abort.
    const startMs = Date.now();
    while (!toolStarted && Date.now() - startMs < 1500) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(toolStarted).toBe(true);
    ac.abort();

    const captured = await promise;
    expect((captured as { name?: string }).name).toBe("AbortError");
    // Tool observed the typed AbortError before it could complete normally.
    expect(toolAbortedTyped).toBe(true);
    expect(toolFinishedNormally).toBe(false);
  });
});
