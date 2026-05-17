// Tests for the kg-conclusion-extractor post_turn hook (Phase 6).
//
// The hook reads buffered tool outputs from scratchpad, calls LLM, and inserts
// ABSTRACTED facts. DB and LLM are mocked; the test validates routing logic,
// scratchpad cleanup, and the SQL statements issued to the mock client.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool } from "pg";

import { Lifecycle } from "../../../src/core/lifecycle.js";
import { registerConclusionExtractorHook } from "../../../src/core/hooks/conclusion-extractor.js";
import type { PostTurnPayload, ToolContext } from "../../../src/core/types.js";
import { StubLlmProvider } from "../../../src/llm/provider.js";

// Mock withUserContext — capture the client queries.
const mockQuery = vi.fn(async () => ({ rows: [{ id: "new-fact-id" }], rowCount: 1 }));
vi.mock("../../../src/db/with-user-context.js", () => ({
  withUserContext: vi.fn(
    async (_pool: unknown, _user: unknown, fn: (c: { query: typeof mockQuery }) => Promise<unknown>) => {
      const client = { query: mockQuery };
      await fn(client);
    },
  ),
}));

const SCRATCHPAD_KEY = "kg_conclusion_inputs";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userEntraId: "user-1",
    orgId: null,
    nceProjectId: "00000000-0000-0000-0000-000000000abc",
    scratchpad: new Map(),
    seenFactIds: new Set(),
    ...overrides,
  };
}

function makePayload(ctx: ToolContext): PostTurnPayload {
  return { ctx, finalText: "Here is the analysis.", stepsUsed: 2 };
}

function makeLlm(result: unknown): StubLlmProvider {
  return new StubLlmProvider().enqueueJson(result);
}

function makePool(): Pool {
  return {} as unknown as Pool;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [{ id: "new-fact-id" }], rowCount: 1 });
});

describe("kg-conclusion-extractor", () => {
  it("skips when scratchpad buffer is empty", async () => {
    const lc = new Lifecycle();
    const llm = makeLlm([]);
    const spy = vi.spyOn(llm, "completeJson");
    registerConclusionExtractorHook(lc, { pool: makePool(), llm });
    const ctx = makeCtx();
    await lc.dispatch("post_turn", makePayload(ctx));
    expect(spy).not.toHaveBeenCalled();
  });

  it("clears the buffer even when skipping (no project)", async () => {
    const lc = new Lifecycle();
    const llm = makeLlm([]);
    const spy = vi.spyOn(llm, "completeJson");
    registerConclusionExtractorHook(lc, { pool: makePool(), llm });
    const ctx = makeCtx({ nceProjectId: null });
    ctx.scratchpad.set(SCRATCHPAD_KEY, [{ toolId: "predict_yield_with_uq", input: {}, output: { ensemble_mean: 80 } }]);
    await lc.dispatch("post_turn", makePayload(ctx));
    expect(ctx.scratchpad.has(SCRATCHPAD_KEY)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("calls LLM when buffer has entries and nceProjectId is set", async () => {
    const lc = new Lifecycle();
    const llm = makeLlm([]);
    const spy = vi.spyOn(llm, "completeJson");
    registerConclusionExtractorHook(lc, { pool: makePool(), llm });
    const ctx = makeCtx();
    ctx.scratchpad.set(SCRATCHPAD_KEY, [{ toolId: "predict_yield_with_uq", input: {}, output: { ensemble_mean: 80 } }]);
    await lc.dispatch("post_turn", makePayload(ctx));
    expect(spy).toHaveBeenCalledOnce();
  });

  it("inserts a fact and emits extracted_fact when LLM returns a valid draft", async () => {
    const lc = new Lifecycle();
    const draft = {
      predicate: "suggests_high_yield",
      subject_label: "Compound",
      subject_id_value: "CCO",
      object_value: { value: 80 },
      unit: "%",
      confidence: 0.65,
      reasoning: "Predicted yield is well above baseline.",
    };
    const llm = makeLlm([draft]);
    registerConclusionExtractorHook(lc, { pool: makePool(), llm });
    const ctx = makeCtx();
    ctx.scratchpad.set(SCRATCHPAD_KEY, [{ toolId: "predict_yield_with_uq", input: {}, output: { ensemble_mean: 80 } }]);
    await lc.dispatch("post_turn", makePayload(ctx));
    // Expect 2 queries: INSERT INTO facts + INSERT INTO ingestion_events.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [factQuery, eventQuery] = mockQuery.mock.calls;
    expect(factQuery[0]).toMatch(/INSERT INTO facts/);
    expect(String(factQuery[0])).toContain("ABSTRACTED");
    expect(eventQuery[0]).toMatch(/INSERT INTO ingestion_events/);
    expect(String(eventQuery[0])).toContain("extracted_fact");
  });

  it("caps confidence at 0.70", async () => {
    const lc = new Lifecycle();
    const draft = {
      predicate: "high_solubility",
      subject_label: "Compound",
      subject_id_value: "c1ccccc1",
      object_value: { value: "good" },
      unit: null,
      confidence: 0.99,
      reasoning: "Very high confidence.",
    };
    const llm = makeLlm([draft]);
    registerConclusionExtractorHook(lc, { pool: makePool(), llm });
    const ctx = makeCtx();
    ctx.scratchpad.set(SCRATCHPAD_KEY, [{ toolId: "assess_applicability_domain", input: {}, output: { in_domain: true } }]);
    await lc.dispatch("post_turn", makePayload(ctx));
    const factArgs = mockQuery.mock.calls[0][1] as unknown[];
    // params: factId, projectId, subjectLabel, subjectIdValue, predicate,
    //         objectValue, unit, confidence (index 7), tier (index 8)
    const confidence = factArgs[7] as number;
    const tier = factArgs[8] as string;
    expect(confidence).toBe(0.70);
    expect(tier).toBe("high"); // 0.70 >= 0.65 threshold
  });

  it("skips drafts missing predicate, subject_label, or subject_id_value", async () => {
    const lc = new Lifecycle();
    const llm = makeLlm([
      { predicate: "", subject_label: "Compound", subject_id_value: "CCO", object_value: {}, confidence: 0.5 },
      { predicate: "valid", subject_label: "", subject_id_value: "CCO", object_value: {}, confidence: 0.5 },
    ]);
    registerConclusionExtractorHook(lc, { pool: makePool(), llm });
    const ctx = makeCtx();
    ctx.scratchpad.set(SCRATCHPAD_KEY, [{ toolId: "predict_molecular_property", input: {}, output: { logP: 1 } }]);
    await lc.dispatch("post_turn", makePayload(ctx));
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("skips insert when facts table returns no row (ON CONFLICT)", async () => {
    const lc = new Lifecycle();
    const draft = {
      predicate: "duplicate_claim",
      subject_label: "Compound",
      subject_id_value: "CCO",
      object_value: { value: 1 },
      confidence: 0.5,
    };
    const llm = makeLlm([draft]);
    // Simulate ON CONFLICT: no RETURNING row.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    registerConclusionExtractorHook(lc, { pool: makePool(), llm });
    const ctx = makeCtx();
    ctx.scratchpad.set(SCRATCHPAD_KEY, [{ toolId: "predict_yield_with_uq", input: {}, output: { ensemble_mean: 60 } }]);
    await lc.dispatch("post_turn", makePayload(ctx));
    // Only the facts INSERT fires; no ingestion_events row.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("clears scratchpad buffer after extraction", async () => {
    const lc = new Lifecycle();
    const llm = makeLlm([]);
    registerConclusionExtractorHook(lc, { pool: makePool(), llm });
    const ctx = makeCtx();
    ctx.scratchpad.set(SCRATCHPAD_KEY, [{ toolId: "qm_crest_screen", input: {}, output: { conformers: [1, 2] } }]);
    await lc.dispatch("post_turn", makePayload(ctx));
    expect(ctx.scratchpad.has(SCRATCHPAD_KEY)).toBe(false);
  });

  it("skips non-array LLM response", async () => {
    const lc = new Lifecycle();
    const llm = makeLlm({ error: "bad response" });
    registerConclusionExtractorHook(lc, { pool: makePool(), llm });
    const ctx = makeCtx();
    ctx.scratchpad.set(SCRATCHPAD_KEY, [{ toolId: "predict_yield_with_uq", input: {}, output: { ensemble_mean: 70 } }]);
    await lc.dispatch("post_turn", makePayload(ctx));
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
