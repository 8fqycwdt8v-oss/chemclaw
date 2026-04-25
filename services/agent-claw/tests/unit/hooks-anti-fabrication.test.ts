// Tests for the anti-fabrication hook (post_tool) and init-scratch hook (pre_turn).

import { describe, it, expect } from "vitest";
import {
  antiFabricationHook,
  extractFactIds,
} from "../../src/core/hooks/anti-fabrication.js";
import { initScratchHook } from "../../src/core/hooks/init-scratch.js";
import { makeCtx } from "../helpers/make-ctx.js";

// ---------- extractFactIds unit tests ----------------------------------------

describe("extractFactIds", () => {
  const UUID_A = "aaaaaaaa-1111-2222-3333-444444444444";
  const UUID_B = "bbbbbbbb-1111-2222-3333-444444444444";

  it("extracts fact_ids from query_kg-shaped output (facts array)", () => {
    const output = {
      facts: [
        { fact_id: UUID_A },
        { fact_id: UUID_B },
      ],
    };
    const ids = extractFactIds(output);
    expect(ids).toContain(UUID_A);
    expect(ids).toContain(UUID_B);
  });

  it("extracts from surfaced_fact_ids array (expand_reaction_context shape)", () => {
    const output = { surfaced_fact_ids: [UUID_A, UUID_B] };
    const ids = extractFactIds(output);
    expect(ids).toContain(UUID_A);
    expect(ids).toContain(UUID_B);
  });

  it("extracts from contradictions[].fact_ids array (check_contradictions shape)", () => {
    const output = {
      contradictions: [
        { kind: "parallel_current_facts", fact_ids: [UUID_A, UUID_B] },
      ],
    };
    const ids = extractFactIds(output);
    expect(ids).toContain(UUID_A);
    expect(ids).toContain(UUID_B);
  });

  it("returns empty array for non-object output", () => {
    expect(extractFactIds("not an object")).toHaveLength(0);
    expect(extractFactIds(null)).toHaveLength(0);
    expect(extractFactIds(42)).toHaveLength(0);
  });

  it("returns empty array for output with no fact_id fields", () => {
    const output = { canonical_smiles: "c1ccccc1", inchikey: "XYZ", formula: "C6H6", mw: 78 };
    expect(extractFactIds(output)).toHaveLength(0);
  });
});

// ---------- antiFabricationHook post_tool tests ------------------------------

describe("antiFabricationHook (post_tool)", () => {
  const UUID_A = "aaaaaaaa-1111-2222-3333-444444444444";
  const UUID_B = "bbbbbbbb-1111-2222-3333-444444444444";

  it("adds fact_ids from query_kg output to seenFactIds", async () => {
    const ctx = makeCtx();
    const output = { facts: [{ fact_id: UUID_A }] };

    await antiFabricationHook({ ctx, toolId: "query_kg", input: {}, output });

    expect(ctx.seenFactIds.has(UUID_A)).toBe(true);
  });

  it("accumulates across multiple tool calls (same ctx)", async () => {
    const ctx = makeCtx();

    await antiFabricationHook({
      ctx,
      toolId: "query_kg",
      input: {},
      output: { facts: [{ fact_id: UUID_A }] },
    });

    await antiFabricationHook({
      ctx,
      toolId: "expand_reaction_context",
      input: {},
      output: { surfaced_fact_ids: [UUID_B] },
    });

    expect(ctx.seenFactIds.has(UUID_A)).toBe(true);
    expect(ctx.seenFactIds.has(UUID_B)).toBe(true);
    expect(ctx.seenFactIds.size).toBe(2);
  });

  it("is a no-op for tools that produce no fact_ids (e.g. canonicalize_smiles)", async () => {
    const ctx = makeCtx();
    const output = { canonical_smiles: "c1ccccc1", inchikey: "XYZ", formula: "C6H6", mw: 78 };

    await antiFabricationHook({ ctx, toolId: "canonicalize_smiles", input: {}, output });

    expect(ctx.seenFactIds.size).toBe(0);
  });

  it("does not throw when output is malformed", async () => {
    const ctx = makeCtx();
    // Should silently swallow the error.
    await expect(
      antiFabricationHook({ ctx, toolId: "unknown", input: {}, output: "bad-output" }),
    ).resolves.toBeUndefined();
  });
});

// ---------- initScratchHook pre_turn tests -----------------------------------

describe("initScratchHook (pre_turn)", () => {
  it("initialises seenFactIds as an empty Set in scratchpad", async () => {
    const ctx = makeCtx();
    ctx.scratchpad.delete("seenFactIds"); // simulate a fresh turn
    ctx.seenFactIds = new Set(["stale-id"]); // has stale data

    await initScratchHook({ ctx, messages: [] });

    const seenFromScratch = ctx.scratchpad.get("seenFactIds") as Set<string>;
    expect(seenFromScratch).toBeInstanceOf(Set);
    expect(seenFromScratch.size).toBe(0);
  });

  it("overwrites any pre-existing seenFactIds (fresh turn semantics)", async () => {
    const ctx = makeCtx("user@test.com", ["old-fact-uuid-1111-111111111111"]);

    await initScratchHook({ ctx, messages: [] });

    const seenAfter = ctx.scratchpad.get("seenFactIds") as Set<string>;
    expect(seenAfter.size).toBe(0);
  });
});
