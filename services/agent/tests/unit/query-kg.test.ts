// Unit tests for query_kg tool — schema validation only.

import { describe, expect, it } from "vitest";
import { QueryKgInput, QueryKgOutput } from "../../src/tools/query-kg.js";

describe("QueryKgInput", () => {
  it("accepts minimal valid entity", () => {
    const v = QueryKgInput.parse({
      entity: { label: "Reaction", id_property: "uuid", id_value: "x" },
    });
    expect(v.direction).toBe("both");
    expect(v.include_invalidated).toBe(false);
  });

  it("rejects lowercase label", () => {
    expect(() =>
      QueryKgInput.parse({
        entity: { label: "reaction", id_property: "uuid", id_value: "x" },
      }),
    ).toThrow();
  });

  it("rejects uppercase id_property", () => {
    expect(() =>
      QueryKgInput.parse({
        entity: { label: "Reaction", id_property: "UUID", id_value: "x" },
      }),
    ).toThrow();
  });

  it("rejects non-aware datetime string", () => {
    expect(() =>
      QueryKgInput.parse({
        entity: { label: "Reaction", id_property: "uuid", id_value: "x" },
        at_time: "2026-04-22 10:00:00",
      }),
    ).toThrow();
  });

  it("accepts ISO-8601 offset datetime", () => {
    const v = QueryKgInput.parse({
      entity: { label: "Reaction", id_property: "uuid", id_value: "x" },
      at_time: "2026-04-22T10:00:00+00:00",
    });
    expect(v.at_time).toBeTruthy();
  });
});

describe("QueryKgOutput", () => {
  it("accepts well-shaped facts", () => {
    const out = QueryKgOutput.parse({
      facts: [
        {
          fact_id: "11111111-1111-1111-1111-111111111111",
          subject: { label: "Reaction", id_property: "uuid", id_value: "R1" },
          predicate: "PRODUCED_OUTCOME",
          object: { label: "Outcome", id_property: "uuid", id_value: "O1" },
          edge_properties: { yield_pct: 73 },
          confidence_tier: "multi_source_llm",
          confidence_score: 0.8,
          t_valid_from: "2026-01-01T00:00:00Z",
          t_valid_to: null,
          recorded_at: "2026-01-01T00:00:00Z",
          provenance: { source_type: "ELN", source_id: "EXP-1" },
        },
      ],
    });
    expect(out.facts.length).toBe(1);
  });

  it("rejects unknown confidence_tier", () => {
    expect(() =>
      QueryKgOutput.parse({
        facts: [
          {
            fact_id: "11111111-1111-1111-1111-111111111111",
            subject: { label: "Reaction", id_property: "uuid", id_value: "R1" },
            predicate: "P",
            object: { label: "Reaction", id_property: "uuid", id_value: "R2" },
            edge_properties: {},
            confidence_tier: "medium",
            confidence_score: 0.5,
            t_valid_from: "now",
            t_valid_to: null,
            recorded_at: "now",
            provenance: { source_type: "ELN", source_id: "x" },
          },
        ],
      }),
    ).toThrow();
  });
});
