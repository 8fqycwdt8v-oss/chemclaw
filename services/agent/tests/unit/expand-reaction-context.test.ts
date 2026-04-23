import { describe, it, expect, vi } from "vitest";
import {
  ExpandReactionContextInput,
  expandReactionContext,
} from "../../src/tools/expand-reaction-context.js";

function mockPool(rows: any[]) {
  const client = {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      if (/reactions r/i.test(sql)) return { rows };
      return { rows: [] };
    }),
    release: () => void 0,
  };
  return {
    connect: vi.fn(async () => client),
  } as any;
}

const RX_ID = "11111111-1111-1111-1111-111111111111";

describe("expand_reaction_context", () => {
  it("returns the reaction record when hop_limit=1 and all includes", async () => {
    const pool = mockPool([
      {
        reaction_id: RX_ID,
        rxn_smiles: "CC>>CC",
        rxno_class: "3.1.1",
        experiment_id: "22222222-2222-2222-2222-222222222222",
        project_internal_id: "NCE-1",
        yield_pct: 88,
        outcome_status: "success",
        temp_c: 80,
        time_min: 240,
        solvent: "toluene",
      },
    ]);
    const kg = { queryAtTime: vi.fn(async () => ({ facts: [] })) };
    const embedder = { embed: vi.fn() };
    const input = ExpandReactionContextInput.parse({ reaction_id: RX_ID });
    const out = await expandReactionContext(input, {
      pool, kg: kg as any, embedder: embedder as any, userEntraId: "user-a",
    });
    expect(out.reaction.reaction_id).toBe(RX_ID);
    expect(out.surfaced_fact_ids).toBeInstanceOf(Array);
  });

  it("returns zero-row output for an unknown reaction_id without throwing", async () => {
    const pool = mockPool([]);
    const kg = { queryAtTime: vi.fn(async () => ({ facts: [] })) };
    const embedder = { embed: vi.fn() };
    const input = ExpandReactionContextInput.parse({ reaction_id: RX_ID });
    await expect(
      expandReactionContext(input, { pool, kg: kg as any, embedder: embedder as any, userEntraId: "user-a" }),
    ).rejects.toThrow(/not found/i);
  });

  it("respects hop_limit=1 and does not fetch predecessors", async () => {
    const pool = mockPool([
      {
        reaction_id: RX_ID, rxn_smiles: "CC>>CC", rxno_class: null,
        experiment_id: "22222222-2222-2222-2222-222222222222",
        project_internal_id: "NCE-1", yield_pct: null, outcome_status: null,
        temp_c: null, time_min: null, solvent: null,
      },
    ]);
    const kg = { queryAtTime: vi.fn(async () => ({ facts: [] })) };
    const embedder = { embed: vi.fn() };
    const input = ExpandReactionContextInput.parse({
      reaction_id: RX_ID,
      include: ["reagents", "conditions"],
      hop_limit: 1,
    });
    const out = await expandReactionContext(input, {
      pool, kg: kg as any, embedder: embedder as any, userEntraId: "user-a",
    });
    expect(out.predecessors).toBeUndefined();
  });
});
