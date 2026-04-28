// Tests for Phase 5 parallel batch execution.
//
// When the LLM emits multiple tool calls in one assistant message
// (kind === "tool_calls"), stepOnce groups read-only tools into a batch
// and runs them via Promise.all. Any state-mutating tool in the batch
// causes the entire batch to fall back to sequential execution.
//
// All tests use StubLlmProvider with enqueueToolCalls — fully deterministic,
// no network.

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { runHarness } from "../../src/core/harness.js";
import { Budget } from "../../src/core/budget.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { defineTool } from "../../src/tools/tool.js";
import type { Message, ToolContext } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): ToolContext {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

function makeMessages(): Message[] {
  return [{ role: "user", content: "go" }];
}

/**
 * Shared counter for the concurrent-execution assertion. The first test
 * uses this to prove parallelism deterministically: increment on enter,
 * record max, decrement on exit. If three tools ran sequentially, max
 * would be 1; in parallel, max is 3.
 */
interface ConcurrencyTracker {
  current: number;
  max: number;
}

/**
 * Build a fake tool that records its start time on `clock`, sleeps for
 * `delayMs`, then resolves. Annotated readOnly: true unless overridden.
 *
 * If `tracker` is provided, the tool also increments `tracker.current` on
 * entry and decrements on exit, recording the peak in `tracker.max`. This
 * lets a test assert "N tools ran concurrently" without relying on wall-
 * clock timing.
 */
function makeRecordingTool(opts: {
  id: string;
  delayMs: number;
  clock: number[];
  readOnly?: boolean;
  throwInside?: boolean;
  tracker?: ConcurrencyTracker;
}) {
  return defineTool({
    id: opts.id,
    description: `Recording tool ${opts.id}.`,
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.object({ id: z.string() }),
    annotations: { readOnly: opts.readOnly ?? true },
    execute: async () => {
      opts.clock.push(Date.now());
      if (opts.tracker) {
        opts.tracker.current += 1;
        if (opts.tracker.current > opts.tracker.max) {
          opts.tracker.max = opts.tracker.current;
        }
      }
      try {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
        if (opts.throwInside) {
          throw new Error(`boom from ${opts.id}`);
        }
        return { id: opts.id };
      } finally {
        if (opts.tracker) {
          opts.tracker.current -= 1;
        }
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parallel batch execution", () => {
  it("read-only tools run in parallel via Promise.all", async () => {
    const startTimes: number[] = [];
    const tracker: ConcurrencyTracker = { current: 0, max: 0 };
    const tools = [
      makeRecordingTool({ id: "ro_a", delayMs: 20, clock: startTimes, tracker }),
      makeRecordingTool({ id: "ro_b", delayMs: 20, clock: startTimes, tracker }),
      makeRecordingTool({ id: "ro_c", delayMs: 20, clock: startTimes, tracker }),
    ];

    const llm = new StubLlmProvider()
      .enqueueToolCalls([
        { toolId: "ro_a", input: {} },
        { toolId: "ro_b", input: {} },
        { toolId: "ro_c", input: {} },
      ])
      .enqueueText("done");

    const messages = makeMessages();
    await runHarness({
      messages,
      tools,
      llm,
      budget: new Budget({ maxSteps: 5 }),
      lifecycle: new Lifecycle(),
      ctx: makeCtx(),
    });

    // Three tool messages should be in history (one per executed tool),
    // followed by the final assistant text.
    const toolMsgs = messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(3);
    expect(toolMsgs.map((m) => m.toolId).sort()).toEqual([
      "ro_a",
      "ro_b",
      "ro_c",
    ]);

    // Deterministic parallelism check: if all three tools were in flight
    // simultaneously, the peak concurrency is 3. If they ran sequentially
    // (e.g. via for-await), the peak would be 1. No wall-clock dependency
    // → CI-stable on busy / slow runners.
    expect(tracker.max).toBe(3);
  });

  it("state-mutating tool causes the entire batch to run sequentially", async () => {
    const startTimes: number[] = [];
    const tools = [
      makeRecordingTool({
        id: "ro_first",
        delayMs: 30,
        clock: startTimes,
        readOnly: true,
      }),
      makeRecordingTool({
        id: "writes_state",
        delayMs: 30,
        clock: startTimes,
        readOnly: false,
      }),
      makeRecordingTool({
        id: "ro_third",
        delayMs: 30,
        clock: startTimes,
        readOnly: true,
      }),
    ];

    const llm = new StubLlmProvider()
      .enqueueToolCalls([
        { toolId: "ro_first", input: {} },
        { toolId: "writes_state", input: {} },
        { toolId: "ro_third", input: {} },
      ])
      .enqueueText("done");

    const messages = makeMessages();
    await runHarness({
      messages,
      tools,
      llm,
      budget: new Budget({ maxSteps: 5 }),
      lifecycle: new Lifecycle(),
      ctx: makeCtx(),
    });

    expect(startTimes).toHaveLength(3);
    // Sequential: each start is at least ~delayMs after the previous one.
    // Assert monotonic increase with a small slack to absorb timer jitter.
    expect(startTimes[1]! - startTimes[0]!).toBeGreaterThanOrEqual(20);
    expect(startTimes[2]! - startTimes[1]!).toBeGreaterThanOrEqual(20);

    // Tool messages should be in declared order.
    const toolMsgs = messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.toolId)).toEqual([
      "ro_first",
      "writes_state",
      "ro_third",
    ]);
  });

  it("dispatches post_tool_batch ONCE per batch with the right entries", async () => {
    const tools = [
      makeRecordingTool({ id: "ro_a", delayMs: 1, clock: [] }),
      makeRecordingTool({ id: "ro_b", delayMs: 1, clock: [] }),
      makeRecordingTool({ id: "ro_c", delayMs: 1, clock: [] }),
    ];

    const llm = new StubLlmProvider()
      .enqueueToolCalls([
        { toolId: "ro_a", input: { a: 1 } },
        { toolId: "ro_b", input: { b: 2 } },
        { toolId: "ro_c", input: { c: 3 } },
      ])
      .enqueueText("done");

    const lifecycle = new Lifecycle();
    const dispatchSpy = vi.spyOn(lifecycle, "dispatch");

    await runHarness({
      messages: makeMessages(),
      tools,
      llm,
      budget: new Budget({ maxSteps: 5 }),
      lifecycle,
      ctx: makeCtx(),
    });

    const batchCalls = dispatchSpy.mock.calls.filter(
      (call) => call[0] === "post_tool_batch",
    );
    expect(batchCalls).toHaveLength(1);
    const payload = batchCalls[0]![1] as { batch: Array<{ toolId: string }> };
    expect(payload.batch).toHaveLength(3);
    expect(payload.batch.map((b) => b.toolId)).toEqual([
      "ro_a",
      "ro_b",
      "ro_c",
    ]);
  });

  it("if one parallel tool throws, post_tool_failure dispatches and the error propagates", async () => {
    const tools = [
      makeRecordingTool({ id: "ro_a", delayMs: 1, clock: [] }),
      makeRecordingTool({
        id: "ro_b_boom",
        delayMs: 1,
        clock: [],
        throwInside: true,
      }),
      makeRecordingTool({ id: "ro_c", delayMs: 1, clock: [] }),
    ];

    const llm = new StubLlmProvider().enqueueToolCalls([
      { toolId: "ro_a", input: {} },
      { toolId: "ro_b_boom", input: {} },
      { toolId: "ro_c", input: {} },
    ]);

    const lifecycle = new Lifecycle();
    const dispatchSpy = vi.spyOn(lifecycle, "dispatch");

    await expect(
      runHarness({
        messages: makeMessages(),
        tools,
        llm,
        budget: new Budget({ maxSteps: 5 }),
        lifecycle,
        ctx: makeCtx(),
      }),
    ).rejects.toThrow(/boom from ro_b_boom/);

    const failureCalls = dispatchSpy.mock.calls.filter(
      (call) => call[0] === "post_tool_failure",
    );
    expect(failureCalls).toHaveLength(1);
    const payload = failureCalls[0]![1] as { toolId: string; error: Error };
    expect(payload.toolId).toBe("ro_b_boom");
    expect(payload.error.message).toMatch(/boom from ro_b_boom/);
  });
});
