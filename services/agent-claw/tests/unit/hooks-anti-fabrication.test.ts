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

  // Tranche 3 / H4 — query_provenance shape: top-level fact_id.
  it("harvests the top-level fact_id from a query_provenance output", () => {
    const UUID = "aaaaaaaa-1111-2222-3333-444444444444";
    const output = {
      fact_id: UUID,
      subject: { label: "Compound", id_property: "inchikey", id_value: "X" },
      predicate: "HAS_YIELD",
      object: { label: "Y", id_property: "id", id_value: "y-1" },
      provenance: { source_type: "ELN", source_id: "ELN-1" },
      confidence_tier: "multi_source_llm",
      confidence_score: 0.8,
      t_valid_from: "2026-01-01T00:00:00Z",
      t_valid_to: null,
      recorded_at: "2026-01-01T00:00:00Z",
      invalidated_at: null,
      invalidation_reason: null,
    };
    expect(extractFactIds(output)).toEqual([UUID]);
  });

  // Tranche 3 / H1 — retrieve_related shape: items[].fact.fact_id, but only
  // for items with kind === 'fact'. chunk items don't contribute fact_ids.
  it("harvests fact_ids from retrieve_related items but skips chunk items", () => {
    const FACT_UUID = "aaaaaaaa-1111-2222-3333-444444444444";
    const CHUNK_UUID = "11111111-2222-3333-4444-555555555555";
    const output = {
      items: [
        {
          kind: "chunk",
          rrf_score: 0.5,
          ranks: [0, -1],
          chunk: { chunk_id: CHUNK_UUID, text: "..." },
        },
        {
          kind: "fact",
          rrf_score: 0.4,
          ranks: [-1, 0],
          fact: { fact_id: FACT_UUID, predicate: "HAS_YIELD" },
        },
      ],
      arm_counts: { chunks: 1, facts: 1 },
    };
    const ids = extractFactIds(output);
    expect(ids).toContain(FACT_UUID);
    expect(ids).not.toContain(CHUNK_UUID);
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
    // Should silently swallow the error and return the no-op HookJSONOutput shape.
    await expect(
      antiFabricationHook({ ctx, toolId: "unknown", input: {}, output: "bad-output" }),
    ).resolves.toEqual({});
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
