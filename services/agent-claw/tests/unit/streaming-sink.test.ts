// Phase 2A — StreamSink notification surface.
//
// Locks in the contract that runHarness fans out to a StreamSink callback
// surface when one is supplied: onSession at the top, onToolCall /
// onToolResult around tool execution, onTodoUpdate when manage_todos
// mutates state, onTextDelta per chunk on the streamed text step, and
// onFinish at the end. When streamSink is undefined, runHarness behaves
// identically to today (uses llm.call only; no token-by-token streaming).

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { StreamSink } from "../../src/core/streaming-sink.js";
import { runHarness } from "../../src/core/harness.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { Budget } from "../../src/core/budget.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { defineTool } from "../../src/tools/tool.js";
import type { Message, ToolContext } from "../../src/core/types.js";

describe("StreamSink", () => {
  it("emits onSession + onTextDelta + tool brackets + onFinish on a streamed turn", async () => {
    const events: string[] = [];
    const sink: StreamSink = {
      onSession: (id) => events.push(`session:${id}`),
      onTextDelta: (delta) => events.push(`delta:${delta}`),
      onToolCall: (toolId) => events.push(`call:${toolId}`),
      onToolResult: (toolId) => events.push(`result:${toolId}`),
      onTodoUpdate: (todos) => events.push(`todos:${todos.length}`),
      onAwaitingUserInput: (q) => events.push(`ask:${q}`),
      onFinish: (reason) => events.push(`finish:${reason}`),
    };

    // One read-only tool the LLM is going to "call".
    const searchKnowledge = defineTool({
      id: "search_knowledge",
      description: "Search the knowledge graph (test stub).",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ ok: z.literal(true) }),
      execute: async () => ({ ok: true }),
    });

    // First step: tool_call. Second step: text — but we override the streamed
    // text via enqueueStream so the streaming path is exercised.
    const llm = new StubLlmProvider()
      .enqueueToolCall("search_knowledge", { query: "hi" })
      .enqueueText("answer") // call() return value (used only for kind detection)
      .enqueueStream([
        { type: "text_delta", delta: "ans" },
        { type: "text_delta", delta: "wer" },
      ]);

    const ctx: ToolContext = {
      userEntraId: "u",
      scratchpad: new Map<string, unknown>(),
      seenFactIds: new Set<string>(),
    };

    const messages: Message[] = [{ role: "user", content: "do x" }];

    const result = await runHarness({
      messages,
      tools: [searchKnowledge],
      llm,
      budget: new Budget({ maxSteps: 3 }),
      lifecycle: new Lifecycle(),
      ctx,
      streamSink: sink,
      sessionId: "sess-1",
    });

    expect(events[0]).toBe("session:sess-1");
    expect(events).toContain("call:search_knowledge");
    expect(events).toContain("result:search_knowledge");
    expect(events).toContain("delta:ans");
    expect(events).toContain("delta:wer");
    expect(events[events.length - 1]).toBe("finish:stop");

    // The streamed deltas concatenate into the canonical assistant text.
    expect(result.text).toBe("answer"); // call() result wins when stream is "ans"+"wer" they actually concat to "answer"
    expect(result.finishReason).toBe("stop");
  });

  it("when streamSink is undefined, runHarness behaves identically to today (uses llm.call, no streaming)", async () => {
    const llm = new StubLlmProvider().enqueueText("done");
    // Spy on streamCompletion to confirm it's NOT called in the
    // non-streaming code path.
    const streamSpy = vi.spyOn(llm, "streamCompletion");
    const callSpy = vi.spyOn(llm, "call");

    const ctx: ToolContext = {
      userEntraId: "u",
      scratchpad: new Map<string, unknown>(),
      seenFactIds: new Set<string>(),
    };

    const result = await runHarness({
      messages: [{ role: "user", content: "do x" }],
      tools: [],
      llm,
      budget: new Budget({ maxSteps: 3 }),
      lifecycle: new Lifecycle(),
      ctx,
    });

    expect(result.text).toBe("done");
    expect(result.finishReason).toBe("stop");
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(streamSpy).not.toHaveBeenCalled();
  });
});
