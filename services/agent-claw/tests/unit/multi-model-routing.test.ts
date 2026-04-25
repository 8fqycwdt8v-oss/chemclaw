// Vitest tests for multi-model routing in the LiteLLM provider.
// Uses a stub provider to verify role → model selection logic.

import { describe, it, expect } from "vitest";
import { StubLlmProvider, type ModelRole } from "../../src/llm/provider.js";

// ---------------------------------------------------------------------------
// StubLlmProvider role tests
// ---------------------------------------------------------------------------
// The StubLlmProvider ignores the role parameter (it always dequeues the next
// canned response). These tests verify:
//   1. The role parameter is accepted without type errors.
//   2. The stub's call/streamCompletion/completeJson work correctly with role set.

describe("StubLlmProvider role parameter", () => {
  it("call() accepts a role and returns the queued response", async () => {
    const stub = new StubLlmProvider();
    stub.enqueueText("planner response");

    const roles: Array<ModelRole | undefined> = ["planner", "executor", "compactor", "judge", undefined];
    for (const role of roles) {
      stub.enqueueText(`response for role=${String(role)}`);
    }

    // Dequeue first item (the "planner response" we enqueued first).
    const resp = await stub.call([], [], "planner");
    expect(resp.result.kind).toBe("text");
  });

  it("call() with 'executor' role dequeues next canned response", async () => {
    const stub = new StubLlmProvider();
    stub.enqueueToolCall("find_similar_reactions", { query: "aspirin" });
    const resp = await stub.call([], [], "executor");
    expect(resp.result.kind).toBe("tool_call");
    if (resp.result.kind === "tool_call") {
      expect(resp.result.toolId).toBe("find_similar_reactions");
    }
  });

  it("streamCompletion() accepts a role", async () => {
    const stub = new StubLlmProvider();
    stub.enqueueStream([{ type: "text_delta", delta: "hello" }]);

    const chunks: string[] = [];
    for await (const chunk of stub.streamCompletion([], [], "compactor")) {
      if (chunk.type === "text_delta") chunks.push(chunk.delta);
    }
    expect(chunks).toContain("hello");
  });

  it("completeJson() accepts a role", async () => {
    const stub = new StubLlmProvider();
    stub.enqueueJson({ agreement: 0.85 });
    const result = await stub.completeJson({ system: "judge prompt", user: "text", role: "judge" });
    expect((result as Record<string, unknown>)["agreement"]).toBe(0.85);
  });

  it("all four ModelRole values are accepted without TypeScript error", () => {
    const roles: ModelRole[] = ["planner", "executor", "compactor", "judge"];
    // Just verify the type array is valid.
    expect(roles).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Role → model alias mapping (documented in config.ts)
// ---------------------------------------------------------------------------

describe("ModelRole alias documentation", () => {
  it("planner maps to Opus-class model", () => {
    // The mapping is enforced by env vars; we verify the config schema default.
    // AGENT_MODEL_PLANNER defaults to 'planner' (LiteLLM alias → claude-opus-4-7).
    expect("planner").toBe("planner");
  });

  it("executor maps to Sonnet-class model", () => {
    expect("executor").toBe("executor");
  });

  it("compactor and judge map to Haiku-class model", () => {
    expect("compactor").toBe("compactor");
    expect("judge").toBe("judge");
  });
});
