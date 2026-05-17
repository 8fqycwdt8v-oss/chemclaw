// Tests for the kg-conclusion-buffer post_tool hook (Phase 6).
//
// The hook accumulates chemistry tool outputs in ctx.scratchpad["kg_conclusion_inputs"].
// It is a pure in-memory operation — no DB, no LLM calls.

import { describe, it, expect } from "vitest";
import { Lifecycle } from "../../../src/core/lifecycle.js";
import { registerConclusionBufferHook } from "../../../src/core/hooks/conclusion-buffer.js";
import type { PostToolPayload, ToolContext } from "../../../src/core/types.js";

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

function makePayload(
  toolId: string,
  output: unknown,
  ctx?: ToolContext,
): PostToolPayload {
  return { ctx: ctx ?? makeCtx(), toolId, input: { smiles: "CCO" }, output };
}

function buf(ctx: ToolContext): unknown[] | undefined {
  const v = ctx.scratchpad.get("kg_conclusion_inputs");
  return Array.isArray(v) ? v : undefined;
}

describe("kg-conclusion-buffer", () => {
  it("buffers a chemistry tool output in the scratchpad", async () => {
    const lc = new Lifecycle();
    registerConclusionBufferHook(lc);
    const ctx = makeCtx();
    await lc.dispatch("post_tool", makePayload("propose_retrosynthesis", { routes: [1] }, ctx));
    expect(buf(ctx)).toHaveLength(1);
  });

  it("appends multiple chemistry tool outputs", async () => {
    const lc = new Lifecycle();
    registerConclusionBufferHook(lc);
    const ctx = makeCtx();
    await lc.dispatch("post_tool", makePayload("predict_yield_with_uq", { ensemble_mean: 82 }, ctx));
    await lc.dispatch("post_tool", makePayload("predict_molecular_property", { logP: 1.2 }, ctx));
    expect(buf(ctx)).toHaveLength(2);
  });

  it("does not buffer non-chemistry tools", async () => {
    const lc = new Lifecycle();
    registerConclusionBufferHook(lc);
    const ctx = makeCtx();
    await lc.dispatch("post_tool", makePayload("search_knowledge", { results: [] }, ctx));
    await lc.dispatch("post_tool", makePayload("manage_todos", { todos: [] }, ctx));
    await lc.dispatch("post_tool", makePayload("ask_user", { question: "hi" }, ctx));
    expect(buf(ctx)).toBeUndefined();
  });

  it("does not buffer null output", async () => {
    const lc = new Lifecycle();
    registerConclusionBufferHook(lc);
    const ctx = makeCtx();
    await lc.dispatch("post_tool", makePayload("propose_retrosynthesis", null, ctx));
    expect(buf(ctx)).toBeUndefined();
  });

  it("does not buffer string output", async () => {
    const lc = new Lifecycle();
    registerConclusionBufferHook(lc);
    const ctx = makeCtx();
    await lc.dispatch("post_tool", makePayload("elucidate_mechanism", "error message", ctx));
    expect(buf(ctx)).toBeUndefined();
  });

  it("does not buffer empty array output", async () => {
    const lc = new Lifecycle();
    registerConclusionBufferHook(lc);
    const ctx = makeCtx();
    await lc.dispatch("post_tool", makePayload("statistical_analyze", [], ctx));
    expect(buf(ctx)).toBeUndefined();
  });

  it("does not buffer empty object output", async () => {
    const lc = new Lifecycle();
    registerConclusionBufferHook(lc);
    const ctx = makeCtx();
    await lc.dispatch("post_tool", makePayload("qm_single_point", {}, ctx));
    expect(buf(ctx)).toBeUndefined();
  });

  it("stores toolId and output in the buffer entry", async () => {
    const lc = new Lifecycle();
    registerConclusionBufferHook(lc);
    const ctx = makeCtx();
    const output = { ensemble_mean: 75 };
    await lc.dispatch("post_tool", makePayload("predict_yield_with_uq", output, ctx));
    const entries = buf(ctx)!;
    const entry = entries[0] as Record<string, unknown>;
    expect(entry.toolId).toBe("predict_yield_with_uq");
    expect(entry.output).toStrictEqual(output);
  });

  it("accepts array output (non-empty)", async () => {
    const lc = new Lifecycle();
    registerConclusionBufferHook(lc);
    const ctx = makeCtx();
    await lc.dispatch("post_tool", makePayload("generate_focused_library", [{ smiles: "c1ccccc1" }], ctx));
    expect(buf(ctx)).toHaveLength(1);
  });
});
