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
      return await realCall(messages, tools);
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

  it("post_turn fires when a tool throws (regression: redact-secrets must run on error paths)", async () => {
    // The cycle-1 fix moved post_turn dispatch into runHarness's finally
    // so redact-secrets always runs even when the tool loop throws. This
    // test pins that contract — without it, a future refactor that moves
    // post_turn back into the happy path would silently break the
    // post-turn redaction guarantee on every tool error path.
    const postTurnSpy = vi.fn();
    const lifecycle = new Lifecycle();
    lifecycle.on("post_turn", "test", async (payload) => {
      postTurnSpy(payload.stepsUsed);
    });

    const llm = new StubLlmProvider().enqueueToolCall("fail_tool", {});
    const opts = makeOptions(llm, { lifecycle, tools: [echoTool, failTool] });

    await expect(runHarness(opts)).rejects.toThrow();
    expect(postTurnSpy, "post_turn fired despite tool throw").toHaveBeenCalledOnce();
  });

  it("post_turn fires when AwaitingUserInputError surfaces (ask_user mid-loop)", async () => {
    // Same finally-block guarantee for the AwaitingUserInputError control-
    // flow exception. ask_user pauses the loop via throw; redact-secrets
    // must still run so the awaiting_question doesn't leak.
    const { AwaitingUserInputError } = await import(
      "../../src/tools/builtins/ask_user.js"
    );
    const postTurnSpy = vi.fn();
    const lifecycle = new Lifecycle();
    lifecycle.on("post_turn", "test", async (payload) => {
      postTurnSpy(payload.stepsUsed);
    });

    const askThrowTool = defineTool({
      id: "ask_user_test",
      description: "Throws AwaitingUserInputError to simulate ask_user.",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async () => {
        throw new AwaitingUserInputError("Which solvent?");
      },
    });

    const llm = new StubLlmProvider().enqueueToolCall("ask_user_test", {});
    const opts = makeOptions(llm, { lifecycle, tools: [askThrowTool] });

    await expect(runHarness(opts)).rejects.toBeInstanceOf(AwaitingUserInputError);
    expect(postTurnSpy, "post_turn fired despite AwaitingUserInputError").toHaveBeenCalledOnce();
  });

  it("post_turn rejection does NOT replace the original loop error", async () => {
    // M-1 from the post-merge review: a misbehaving post_turn hook (e.g.
    // redact-secrets throwing on a malformed scratchpad) must not swallow
    // the original BudgetExceededError / tool error. The harness wraps
    // the post_turn dispatch in its own try/catch.
    const lifecycle = new Lifecycle();
    lifecycle.on("post_turn", "buggy", async () => {
      throw new Error("post_turn handler is buggy");
    });

    const llm = new StubLlmProvider().enqueueToolCall("fail_tool", {});
    const opts = makeOptions(llm, { lifecycle, tools: [echoTool, failTool] });

    // The original tool-thrown error must propagate, NOT the post_turn one.
    await expect(runHarness(opts)).rejects.toThrow(/intentional tool failure/i);
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
