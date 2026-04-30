// Tests for shadow prompt evaluator — Phase E.

import { describe, it, expect, vi } from "vitest";
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

    const evaluator = new ShadowEvaluator(registry as never, llm, makePool() as never, 1.0);
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

    const evaluator = new ShadowEvaluator(registry as never, llm, makePool() as never, 1.0);
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

    const evaluator = new ShadowEvaluator(registry as never, llm, makePool() as never, 0.0);
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

    const evaluator = new ShadowEvaluator(registry as never, llm, makePool() as never, 1.0);
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

    const evaluator = new ShadowEvaluator(registry as never, llm, makePool() as never, 1.0);
    const ctx: ShadowEvalContext = {
      promptName: "agent.system",
      messages: [{ role: "user", content: "Q?" }],
      traceId: "t3",
      userEntraId: "user@test.com",
    };

    await evaluator.evaluateAsync(ctx);

    const callArgs = (registry.recordShadowScore).mock.calls[0]!;
    // callArgs = [promptName, version, traceId, score, perClassScores]
    const score = callArgs[3] as number;
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Phase G next-pass #10 — shadow score uses citation-faithfulness signal
// ---------------------------------------------------------------------------

describe("ShadowEvaluator — citation-faithfulness scoring", () => {
  it("scores 1.0 (no claims) for a response without UUID citations", async () => {
    const ShadowEvaluator = await importEvaluator();
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const registry = makeRegistry([
      { template: "shadow prompt", version: 2, shadowUntil: futureDate },
    ]);
    // Plain response, no UUIDs — should score high (faith=1.0 trivially).
    const llm = makeLlm("Use a C18 column with 30:70 ACN/water mobile phase.");
    const evaluator = new ShadowEvaluator(registry as never, llm, makePool() as never, 1.0);
    await evaluator.evaluateAsync({
      promptName: "agent.system",
      messages: [{ role: "user", content: "What HPLC method?" }],
      traceId: "t1",
      userEntraId: "user@test.com",
    });
    const call = registry.recordShadowScore.mock.calls[0]!;
    const score = call[3] as number;
    // 0.8 * 1.0 (faithful) + 0.2 * lenScore.
    // Length of the response above is ~62 chars, lenScore ≈ 1 - |62-600|/3000 ≈ 0.821.
    expect(score).toBeGreaterThan(0.85);
  });

  it("scores 0.0-faith when response cites an unsupported UUID", async () => {
    const ShadowEvaluator = await importEvaluator();
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const registry = makeRegistry([
      { template: "shadow prompt", version: 2, shadowUntil: futureDate },
    ]);
    // Fabricated UUID — shadow has no tool_outputs to ground against, so
    // any cited UUID counts as unfaithful → faith=0.0.
    const fakeUuid = "12345678-1234-1234-1234-123456789012";
    const responseText = `According to fact ${fakeUuid}, use C18.`;
    const llm = makeLlm(responseText);
    const evaluator = new ShadowEvaluator(registry as never, llm, makePool() as never, 1.0);
    await evaluator.evaluateAsync({
      promptName: "agent.system",
      messages: [{ role: "user", content: "What HPLC method?" }],
      traceId: "t1",
      userEntraId: "user@test.com",
    });
    const call = registry.recordShadowScore.mock.calls[0]!;
    const score = call[3] as number;
    // 0.8 * 0 (unfaithful) + 0.2 * lenScore (~0.83) ≈ 0.166.
    // Below the 0.80 promotion floor — fabricator prompts get rejected.
    expect(score).toBeLessThan(0.30);
  });
});
