// Tests pinning loop semantics for runHarness / buildAgent.
// All tests use StubLlmProvider for deterministic, zero-network execution.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runHarness } from "../../src/core/harness.js";
import { Budget, BudgetExceededError } from "../../src/core/budget.js";
import { Lifecycle } from "../../src/core/lifecycle.js";
import { StubLlmProvider } from "../../src/llm/provider.js";
import { defineTool } from "../../src/tools/tool.js";
import { z } from "zod";
import type { HarnessOptions, Message, ToolContext } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCtx(): ToolContext {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

function makeMessages(userText = "Hello"): Message[] {
  return [{ role: "user", content: userText }];
}

const echoTool = defineTool({
  id: "echo",
  description: "Echo the input.",
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ echoed: z.string() }),
  execute: async (_ctx, { text }) => ({ echoed: text }),
});

const failTool = defineTool({
  id: "fail_tool",
  description: "Always throws.",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  execute: async () => {
    throw new Error("intentional tool failure");
  },
});

function makeOptions(
  llm: StubLlmProvider,
  overrides: Partial<HarnessOptions> = {},
): HarnessOptions {
  return {
    messages: makeMessages(),
    tools: [echoTool],
    llm,
    budget: new Budget({ maxSteps: 10 }),
    lifecycle: new Lifecycle(),
    ctx: makeCtx(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runHarness — loop semantics", () => {
  it("terminates immediately on finishReason='stop' (text response)", async () => {
    const llm = new StubLlmProvider().enqueueText("Hello from the model");
    const opts = makeOptions(llm);
    const result = await runHarness(opts);

    expect(result.finishReason).toBe("stop");
    expect(result.text).toBe("Hello from the model");
    expect(result.stepsUsed).toBe(1);
  });

  it("resolves tools from the tools array by id", async () => {
    const executeSpy = vi.fn().mockResolvedValue({ echoed: "world" });
    const spiedEcho = defineTool({
      ...echoTool,
      execute: executeSpy,
    });

    const llm = new StubLlmProvider()
      .enqueueToolCall("echo", { text: "world" })
      .enqueueText("Done");

    const opts = makeOptions(llm, { tools: [spiedEcho] });
    const result = await runHarness(opts);

    expect(executeSpy).toHaveBeenCalledOnce();
    expect(executeSpy).toHaveBeenCalledWith(opts.ctx, { text: "world" });
    expect(result.finishReason).toBe("stop");
    expect(result.stepsUsed).toBe(2);
  });

  it("throws on missing tool id", async () => {
    const llm = new StubLlmProvider().enqueueToolCall("nonexistent_tool", {});
    const opts = makeOptions(llm, { tools: [] });

    await expect(runHarness(opts)).rejects.toThrow(/nonexistent_tool/);
  });

  it("breaks loop with reason='max_steps' when step cap is reached", async () => {
    // Provide 3 tool_call responses but cap at 2 steps.
    const llm = new StubLlmProvider()
      .enqueueToolCall("echo", { text: "a" })
      .enqueueToolCall("echo", { text: "b" })
      .enqueueToolCall("echo", { text: "c" })
      .enqueueText("Done"); // never reached

    const budget = new Budget({ maxSteps: 2 });
    const opts = makeOptions(llm, { budget });
    const result = await runHarness(opts);

    expect(result.finishReason).toBe("max_steps");
    expect(result.stepsUsed).toBe(2);
    // LLM was called exactly twice before the cap was hit.
    expect(llm.pending).toBe(2); // 2 undequeued responses remain
  });

  it("accumulates tool results in messages before next LLM call", async () => {
    const capturedMessages: Message[][] = [];

    const spyProvider: StubLlmProvider = new StubLlmProvider();
    // Override call to capture messages, then delegate to the stub.
    const realCall = spyProvider.call.bind(spyProvider);
    spyProvider.call = async (messages, tools) => {
      capturedMessages.push([...messages]);
      return realCall(messages, tools);
    };

    spyProvider
      .enqueueToolCall("echo", { text: "ping" })
      .enqueueText("all done");

    const opts = makeOptions(spyProvider);
    await runHarness(opts);

    // First call: just the user message.
    expect(capturedMessages[0]).toHaveLength(1);
    expect(capturedMessages[0]![0]!.role).toBe("user");

    // Second call: user message + tool result.
    expect(capturedMessages[1]).toHaveLength(2);
    const toolMsg = capturedMessages[1]![1]!;
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content).toContain("ping");
  });

  it("token budget overflow throws BudgetExceededError", async () => {
    const llm = new StubLlmProvider().enqueue({
      result: { kind: "tool_call", toolId: "echo", input: { text: "x" } },
      usage: { promptTokens: 999_999, completionTokens: 0 },
    });

    const budget = new Budget({ maxSteps: 10, maxPromptTokens: 100 });
    const opts = makeOptions(llm, { budget });

    await expect(runHarness(opts)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("post_turn fires exactly once even when loop finishes via max_steps", async () => {
    const postTurnSpy = vi.fn();
    const lifecycle = new Lifecycle();
    lifecycle.on("post_turn", "test", async (payload) => {
      postTurnSpy(payload.stepsUsed);
    });

    const llm = new StubLlmProvider()
      .enqueueToolCall("echo", { text: "a" })
      .enqueueText("Done");

    const budget = new Budget({ maxSteps: 1 });
    const opts = makeOptions(llm, { lifecycle, budget });
    await runHarness(opts);

    expect(postTurnSpy).toHaveBeenCalledOnce();
    expect(postTurnSpy).toHaveBeenCalledWith(1);
  });

  it("multi-tool turn: tool called twice before final text", async () => {
    const executeSpy = vi.fn().mockResolvedValue({ echoed: "ok" });
    const spiedEcho = defineTool({ ...echoTool, execute: executeSpy });

    const llm = new StubLlmProvider()
      .enqueueToolCall("echo", { text: "first" })
      .enqueueToolCall("echo", { text: "second" })
      .enqueueText("Final answer");

    const opts = makeOptions(llm, { tools: [spiedEcho] });
    const result = await runHarness(opts);

    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("Final answer");
    expect(result.stepsUsed).toBe(3);
  });

  it("token usage accumulates across all steps", async () => {
    const llm = new StubLlmProvider()
      .enqueue({
        result: { kind: "tool_call", toolId: "echo", input: { text: "hi" } },
        usage: { promptTokens: 50, completionTokens: 10 },
      })
      .enqueue({
        result: { kind: "text", text: "done" },
        usage: { promptTokens: 60, completionTokens: 20 },
      });

    const opts = makeOptions(llm);
    const result = await runHarness(opts);

    expect(result.usage.promptTokens).toBe(110);
    expect(result.usage.completionTokens).toBe(30);
  });
});
