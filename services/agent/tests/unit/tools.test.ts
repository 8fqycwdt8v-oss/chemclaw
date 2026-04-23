// Vitest unit tests for the agent's tool layer.
//
// We test input-schema rejection and the bit-vector literal encoding that
// goes into pgvector queries. The full end-to-end (agent → DRFP → pgvector)
// lives in tests/integration/ and requires the compose stack.

import { describe, it, expect } from "vitest";
import {
  FindSimilarReactionsInput,
  FindSimilarReactionsOutput,
} from "../../src/tools/find-similar-reactions.js";

describe("FindSimilarReactionsInput", () => {
  it("accepts valid input", () => {
    const v = FindSimilarReactionsInput.parse({
      rxn_smiles: "C>>CC",
      k: 5,
    });
    expect(v.k).toBe(5);
  });

  it("rejects empty rxn_smiles", () => {
    expect(() => FindSimilarReactionsInput.parse({ rxn_smiles: "" })).toThrow();
  });

  it("rejects k outside bounds", () => {
    expect(() => FindSimilarReactionsInput.parse({ rxn_smiles: "C>>CC", k: 0 })).toThrow();
    expect(() => FindSimilarReactionsInput.parse({ rxn_smiles: "C>>CC", k: 51 })).toThrow();
  });

  it("rejects oversized rxn_smiles", () => {
    const huge = "C".repeat(20_001);
    expect(() => FindSimilarReactionsInput.parse({ rxn_smiles: huge })).toThrow();
  });

  it("defaults k to 10", () => {
    const v = FindSimilarReactionsInput.parse({ rxn_smiles: "C>>CC" });
    expect(v.k).toBe(10);
  });
});

describe("FindSimilarReactionsOutput", () => {
  it("accepts well-shaped output", () => {
    const out = FindSimilarReactionsOutput.parse({
      seed_canonicalized: { rxn_smiles: "C>>CC", on_bit_count: 7 },
      results: [
        {
          reaction_id: "11111111-1111-1111-1111-111111111111",
          rxn_smiles: "C>>CC",
          rxno_class: "X",
          distance: 0.12,
          experiment_id: "22222222-2222-2222-2222-222222222222",
          eln_entry_id: "ELN-1",
          project_internal_id: "NCE-001",
          yield_pct: 75.0,
          outcome_status: "success",
        },
      ],
    });
    expect(out.results).toHaveLength(1);
  });
});
