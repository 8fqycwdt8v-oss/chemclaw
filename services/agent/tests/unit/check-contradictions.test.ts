// Unit tests for check_contradictions — focuses on the parallel-facts
// detector logic with a mocked mcp-kg client. The Neo4j side is covered
// by integration tests.

import { describe, expect, it } from "vitest";
import {
  CheckContradictionsInput,
  checkContradictions,
} from "../../src/tools/check-contradictions.js";

function mockKg(facts: {
  current: any[];
  contradicts: any[];
}) {
  return {
    kg: {
      queryAtTime: async (req: any) => {
        if (req.predicate === "CONTRADICTS") return { facts: facts.contradicts };
        return { facts: facts.current };
      },
    } as any,
  };
}

function fact(overrides: Partial<any>) {
  return {
    fact_id: overrides.fact_id ?? "11111111-1111-1111-1111-111111111111",
    subject: { label: "Reaction", id_property: "uuid", id_value: "R-1" },
    predicate: overrides.predicate ?? "PRODUCED_OUTCOME",
    object: overrides.object ?? {
      label: "Outcome",
      id_property: "uuid",
      id_value: "O-1",
    },
    edge_properties: {},
    confidence_tier: "multi_source_llm",
    confidence_score: 0.8,
    t_valid_from: "2026-01-01T00:00:00Z",
    t_valid_to: null,
    recorded_at: "2026-01-01T00:00:00Z",
    provenance: { source_type: "ELN", source_id: "EXP-1" },
  };
}

describe("CheckContradictionsInput", () => {
  it("accepts a valid entity", () => {
    CheckContradictionsInput.parse({
      entity: {
        label: "Reaction",
        id_property: "uuid",
        id_value: "11111111-1111-1111-1111-111111111111",
      },
    });
  });

  it("rejects invalid predicate shape", () => {
    expect(() =>
      CheckContradictionsInput.parse({
        entity: { label: "Reaction", id_property: "uuid", id_value: "x" },
        predicate: "has outcome",
      }),
    ).toThrow();
  });
});

describe("checkContradictions", () => {
  it("surfaces parallel facts with same predicate and different objects", async () => {
    const deps = mockKg({
      current: [
        fact({
          fact_id: "11111111-1111-1111-1111-111111111111",
          predicate: "PRODUCED_OUTCOME",
          object: { label: "Outcome", id_property: "uuid", id_value: "O-1" },
        }),
        fact({
          fact_id: "22222222-2222-2222-2222-222222222222",
          predicate: "PRODUCED_OUTCOME",
          object: { label: "Outcome", id_property: "uuid", id_value: "O-2" },
        }),
      ],
      contradicts: [],
    });
    const out = await checkContradictions(
      {
        entity: { label: "Reaction", id_property: "uuid", id_value: "R-1" },
      },
      deps,
    );
    expect(out.contradictions.length).toBe(1);
    const c = out.contradictions[0]!;
    expect(c.kind).toBe("parallel_current_facts");
    expect(c.predicate).toBe("PRODUCED_OUTCOME");
    expect(c.fact_ids.length).toBe(2);
  });

  it("does NOT flag single fact per predicate", async () => {
    const deps = mockKg({
      current: [fact({ predicate: "PRODUCED_OUTCOME" })],
      contradicts: [],
    });
    const out = await checkContradictions(
      {
        entity: { label: "Reaction", id_property: "uuid", id_value: "R-1" },
      },
      deps,
    );
    expect(out.contradictions).toEqual([]);
  });

  it("does NOT flag parallel facts that point to the same object", async () => {
    // Two fact rows both from R-1 to O-1 — same target; not a conflict.
    const deps = mockKg({
      current: [
        fact({
          fact_id: "11111111-1111-1111-1111-111111111111",
          predicate: "HAS_REAGENT",
          object: { label: "Compound", id_property: "inchikey", id_value: "K1" },
        }),
        fact({
          fact_id: "22222222-2222-2222-2222-222222222222",
          predicate: "HAS_REAGENT",
          object: { label: "Compound", id_property: "inchikey", id_value: "K1" },
        }),
      ],
      contradicts: [],
    });
    const out = await checkContradictions(
      {
        entity: { label: "Reaction", id_property: "uuid", id_value: "R-1" },
      },
      deps,
    );
    expect(out.contradictions).toEqual([]);
  });

  it("surfaces explicit CONTRADICTS edges", async () => {
    const deps = mockKg({
      current: [],
      contradicts: [
        fact({
          fact_id: "33333333-3333-3333-3333-333333333333",
          predicate: "CONTRADICTS",
        }),
      ],
    });
    const out = await checkContradictions(
      {
        entity: { label: "Reaction", id_property: "uuid", id_value: "R-1" },
      },
      deps,
    );
    expect(out.contradictions.length).toBe(1);
    expect(out.contradictions[0]!.kind).toBe("explicit_contradicts_edge");
  });
});
