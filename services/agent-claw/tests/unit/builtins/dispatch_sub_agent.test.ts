// Tests for the dispatch_sub_agent builtin tool.

import { describe, it, expect } from "vitest";
import { buildDispatchSubAgentTool } from "../../../src/tools/builtins/dispatch_sub_agent.js";
import { defineTool } from "../../../src/tools/tool.js";
import { StubLlmProvider } from "../../../src/llm/provider.js";
import { z } from "zod";
import type { ToolContext } from "../../../src/core/types.js";

function makeCtx(): ToolContext {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>();
  scratchpad.set("seenFactIds", seenFactIds);
  return {
    userEntraId: "dispatch-test@example.com",
    seenFactIds,
    scratchpad,
  };
}

// Stub tool that the sub-agents can call.
const echoTool = defineTool({
  id: "search_knowledge",
  description: "stub",
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({ result: z.string() }),
  execute: async (_ctx, input) => ({ result: `echo: ${input.query}` }),
});

// A stub LLM that immediately returns a text response.
const stubLlm = new StubLlmProvider();

describe("dispatch_sub_agent — registration", () => {
  it("tool has the correct id", () => {
    const tool = buildDispatchSubAgentTool([echoTool], stubLlm);
    expect(tool.id).toBe("dispatch_sub_agent");
  });

  it("input schema accepts all three types", () => {
    const tool = buildDispatchSubAgentTool([echoTool], stubLlm);
    expect(() =>
      tool.inputSchema.parse({ type: "chemist", goal: "do things", inputs: {} }),
    ).not.toThrow();
    expect(() =>
      tool.inputSchema.parse({ type: "analyst", goal: "do things" }),
    ).not.toThrow();
    expect(() =>
      tool.inputSchema.parse({ type: "reader", goal: "do things" }),
    ).not.toThrow();
  });

  it("rejects unknown sub-agent types", () => {
    const tool = buildDispatchSubAgentTool([echoTool], stubLlm);
    expect(() =>
      tool.inputSchema.parse({ type: "wizard", goal: "do things" }),
    ).toThrow();
  });
});

describe("dispatch_sub_agent — execution", () => {
  it("dispatches a reader sub-agent and returns structured result", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueText("The document says the yield is 87%.");

    const tool = buildDispatchSubAgentTool([echoTool], llm);
    const ctx = makeCtx();

    const result = await tool.execute(ctx, {
      type: "reader",
      goal: "Find the yield for compound A.",
      inputs: { compound_id: "CPD-001" },
    });

    expect(result.type).toBe("reader");
    expect(result.text).toContain("yield is 87%");
    expect(result.finish_reason).toBe("stop");
    expect(typeof result.steps_used).toBe("number");
    expect(result.usage.prompt_tokens).toBeGreaterThanOrEqual(0);
  });

  it("inherits parent userEntraId in the sub-agent context", async () => {
    const llm = new StubLlmProvider();
    let capturedUserId = "";

    const captureTool = defineTool({
      id: "search_knowledge",
      description: "stub",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ result: z.string() }),
      execute: async (subCtx, input) => {
        capturedUserId = subCtx.userEntraId;
        return { result: `echo: ${input.query}` };
      },
    });

    // Force the sub-agent to call search_knowledge then text.
    llm.enqueueToolCall("search_knowledge", { query: "test" });
    llm.enqueueText("done");

    const tool = buildDispatchSubAgentTool([captureTool], llm);
    const ctx = makeCtx();
    ctx.userEntraId = "parent-user@example.com";

    await tool.execute(ctx, {
      type: "reader",
      goal: "Search something.",
      inputs: {},
    });

    expect(capturedUserId).toBe("parent-user@example.com");
  });

  it("enforces step budget on the sub-agent", async () => {
    const llm = new StubLlmProvider();
    // Enqueue more tool calls than max_steps=2 allows.
    for (let i = 0; i < 5; i++) {
      llm.enqueueToolCall("search_knowledge", { query: "q" });
    }
    // Final text step.
    llm.enqueueText("done");

    const tool = buildDispatchSubAgentTool([echoTool], llm);
    const ctx = makeCtx();

    const result = await tool.execute(ctx, {
      type: "reader",
      goal: "Loop forever.",
      inputs: {},
      max_steps: 2,
    });

    // Should have stopped after 2 steps (max_steps hit).
    expect(result.steps_used).toBeLessThanOrEqual(2);
    expect(["max_steps", "stop"]).toContain(result.finish_reason);
  });
});
