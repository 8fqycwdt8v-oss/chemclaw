// Unit tests for search_knowledge.
//
// We test the input/output schemas and the pure RRF fusion logic. Actual
// pgvector + pg_trgm queries are covered by integration tests (Postgres
// required). Keeping the SQL builder code close to Postgres-idiomatic
// parameterisation is the safety mechanism — the tests here lock down the
// scoring math and schema invariants.

import { describe, expect, it } from "vitest";
import {
  SearchKnowledgeInput,
  SearchKnowledgeOutput,
  _rrfForTests,
} from "../../src/tools/search-knowledge.js";

describe("SearchKnowledgeInput", () => {
  it("accepts a minimal valid input", () => {
    const v = SearchKnowledgeInput.parse({ query: "Pd-catalyzed Suzuki" });
    expect(v.k).toBe(10);
    expect(v.mode).toBe("hybrid");
  });

  it("rejects empty queries", () => {
    expect(() => SearchKnowledgeInput.parse({ query: "" })).toThrow();
  });

  it("rejects oversize queries", () => {
    expect(() =>
      SearchKnowledgeInput.parse({ query: "x".repeat(4_001) }),
    ).toThrow();
  });

  it("rejects invalid k", () => {
    expect(() =>
      SearchKnowledgeInput.parse({ query: "q", k: 0 }),
    ).toThrow();
    expect(() =>
      SearchKnowledgeInput.parse({ query: "q", k: 51 }),
    ).toThrow();
  });

  it("accepts dense / sparse / hybrid modes", () => {
    for (const mode of ["dense", "sparse", "hybrid"] as const) {
      const v = SearchKnowledgeInput.parse({ query: "q", mode });
      expect(v.mode).toBe(mode);
    }
  });

  it("rejects unknown source_types", () => {
    expect(() =>
      SearchKnowledgeInput.parse({ query: "q", source_types: ["bogus"] as any }),
    ).toThrow();
  });
});

describe("SearchKnowledgeOutput", () => {
  it("accepts a well-shaped hit", () => {
    const out = SearchKnowledgeOutput.parse({
      mode: "hybrid",
      hits: [
        {
          chunk_id: "11111111-1111-1111-1111-111111111111",
          document_id: "22222222-2222-2222-2222-222222222222",
          heading_path: "A > B",
          text: "some text",
          source_type: "SOP",
          document_title: "Title",
          score: 0.87,
        },
      ],
    });
    expect(out.hits.length).toBe(1);
  });
});

describe("Reciprocal Rank Fusion", () => {
  const row = (id: string) =>
    ({
      chunk_id: id,
      document_id: `doc-${id}`,
      heading_path: null,
      text: id,
      source_type: "SOP",
      document_title: null,
    }) as any;

  it("boosts chunks appearing in multiple rankings", () => {
    const dense = [row("a"), row("b"), row("c")];
    const sparse = [row("b"), row("a"), row("d")];
    const fused = _rrfForTests([dense, sparse], 60, 10);
    // "a" and "b" appear in both; "b" is rank 2 in dense, rank 1 in sparse;
    // "a" is rank 1 in dense, rank 2 in sparse. Both must rank above "c" and "d".
    const ids = fused.map((h) => h.chunk_id);
    expect(ids.slice(0, 2).sort()).toEqual(["a", "b"]);
    expect(ids[2]).toBe("c");
    expect(ids[3]).toBe("d");
  });

  it("limits the fused result to `limit`", () => {
    const dense = [row("a"), row("b"), row("c"), row("d")];
    const sparse = [row("e"), row("f"), row("g"), row("h")];
    const fused = _rrfForTests([dense, sparse], 60, 3);
    expect(fused.length).toBe(3);
  });

  it("handles disjoint rankings", () => {
    const dense = [row("a"), row("b")];
    const sparse = [row("c"), row("d")];
    const fused = _rrfForTests([dense, sparse], 60, 10);
    expect(new Set(fused.map((h) => h.chunk_id))).toEqual(
      new Set(["a", "b", "c", "d"]),
    );
  });

  it("empty input yields empty output", () => {
    expect(_rrfForTests([], 60, 10)).toEqual([]);
    expect(_rrfForTests([[], []], 60, 10)).toEqual([]);
  });
});
