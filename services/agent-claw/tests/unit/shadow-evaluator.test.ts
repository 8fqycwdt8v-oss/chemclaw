// Tests for shadow prompt evaluator — Phase E.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ShadowEvalContext } from "../../src/prompts/shadow-evaluator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(shadows: Array<{ template: string; version: number; shadowUntil: Date }>) {
  return {
    getShadowPrompts: vi.fn().mockResolvedValue(shadows),
    recordShadowScore: vi.fn().mockResolvedValue(undefined),
  };
}

function makeLlm(response: string) {
  return {
    completeJson: vi.fn().mockResolvedValue({ text: response }),
    call: vi.fn(),
    streamCompletion: vi.fn(),
  };
}

function makePool() {
  return {};
}

// ---------------------------------------------------------------------------
// ShadowEvaluator import
// ---------------------------------------------------------------------------

async function importEvaluator() {
  const mod = await import("../../src/prompts/shadow-evaluator.js");
  return mod.ShadowEvaluator;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ShadowEvaluator", () => {
  it("does nothing when no shadow prompts exist", async () => {
    const ShadowEvaluator = await importEvaluator();
    const registry = makeRegistry([]);
    const llm = makeLlm("response");

    const evaluator = new ShadowEvaluator(registry as never, llm as never, makePool() as never, 1.0);
    const ctx: ShadowEvalContext = {
      promptName: "agent.system",
      messages: [{ role: "user", content: "Q?" }],
      traceId: "trace-1",
      userEntraId: "user@test.com",
    };

    await evaluator.evaluateAsync(ctx);
    expect(llm.completeJson).not.toHaveBeenCalled();
    expect(registry.recordShadowScore).not.toHaveBeenCalled();
  });

  it("calls LLM and records score for each shadow prompt", async () => {
    const ShadowEvaluator = await importEvaluator();
    const shadow = {
      template: "Shadow prompt template",
      version: 2,
      shadowUntil: new Date(Date.now() + 86400000),
    };
    const registry = makeRegistry([shadow]);
    const llm = makeLlm("A detailed response about synthesis routes with 10 words here for scoring.");

    const evaluator = new ShadowEvaluator(registry as never, llm as never, makePool() as never, 1.0);
    const ctx: ShadowEvalContext = {
      promptName: "agent.system",
      messages: [{ role: "user", content: "Q?" }],
      traceId: "trace-2",
      userEntraId: "user@test.com",
    };

    await evaluator.evaluateAsync(ctx);

    expect(llm.completeJson).toHaveBeenCalledOnce();
    expect(registry.recordShadowScore).toHaveBeenCalledWith(
      "agent.system",
      2,
      "trace-2",
      expect.any(Number),
      null,
    );
  });

  it("skips evaluation at sampleRate=0", async () => {
    const ShadowEvaluator = await importEvaluator();
    const registry = makeRegistry([{ template: "T", version: 2, shadowUntil: new Date(Date.now() + 86400000) }]);
    const llm = makeLlm("response");

    const evaluator = new ShadowEvaluator(registry as never, llm as never, makePool() as never, 0.0);
    const ctx: ShadowEvalContext = {
      promptName: "agent.system",
      messages: [{ role: "user", content: "Q?" }],
      traceId: null,
      userEntraId: "user@test.com",
    };

    await evaluator.evaluateAsync(ctx);
    expect(llm.completeJson).not.toHaveBeenCalled();
  });

  it("swallows errors without throwing", async () => {
    const ShadowEvaluator = await importEvaluator();
    const registry = {
      getShadowPrompts: vi.fn().mockRejectedValue(new Error("DB down")),
      recordShadowScore: vi.fn(),
    };
    const llm = makeLlm("response");

    const evaluator = new ShadowEvaluator(registry as never, llm as never, makePool() as never, 1.0);
    const ctx: ShadowEvalContext = {
      promptName: "agent.system",
      messages: [{ role: "user", content: "Q?" }],
      traceId: null,
      userEntraId: "user@test.com",
    };

    // Must not throw.
    await expect(evaluator.evaluateAsync(ctx)).resolves.toBeUndefined();
  });

  it("records score in valid [0,1] range", async () => {
    const ShadowEvaluator = await importEvaluator();
    const shadow = {
      template: "Template",
      version: 3,
      shadowUntil: new Date(Date.now() + 86400000),
    };
    const registry = makeRegistry([shadow]);
    const llm = makeLlm("Short response.");

    const evaluator = new ShadowEvaluator(registry as never, llm as never, makePool() as never, 1.0);
    const ctx: ShadowEvalContext = {
      promptName: "agent.system",
      messages: [{ role: "user", content: "Q?" }],
      traceId: "t3",
      userEntraId: "user@test.com",
    };

    await evaluator.evaluateAsync(ctx);

    const callArgs = (registry.recordShadowScore as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // callArgs = [promptName, version, traceId, score, perClassScores]
    const score = callArgs[3] as number;
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
