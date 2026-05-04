// Tests for the generic RRF utility — Tranche 3 / H1.
//
// The same math also backs search_knowledge's dense+sparse fusion; pinning
// it here means the value is the contract, not an implementation detail.

import { describe, it, expect } from "vitest";
import { rrfMerge, DEFAULT_RRF_K } from "../../src/core/rrf.js";

interface Doc {
  id: string;
  body?: string;
}

describe("rrfMerge", () => {
  it("DEFAULT_RRF_K is the canonical 60", () => {
    expect(DEFAULT_RRF_K).toBe(60);
  });

  it("merges two lists with identical entries to double the score", () => {
    const a: Doc[] = [{ id: "x" }];
    const b: Doc[] = [{ id: "x" }];
    const merged = rrfMerge([a, b], { key: (d) => d.id });
    expect(merged).toHaveLength(1);
    // 1/(60+1) + 1/(60+1) = 2/61
    expect(merged[0]!.score).toBeCloseTo(2 / 61, 5);
    expect(merged[0]!.ranks).toEqual([0, 0]);
  });

  it("ranks items by aggregate score across all lists", () => {
    // Item x: rank 0 in list a, rank 2 in list b → 1/61 + 1/63 ≈ 0.03226
    // Item y: rank 1 in list a, rank 0 in list b → 1/62 + 1/61 ≈ 0.03252
    // Item z: rank 2 in list a, rank 1 in list b → 1/63 + 1/62 ≈ 0.03200
    // Sorted descending: y, x, z.
    const a: Doc[] = [{ id: "x" }, { id: "y" }, { id: "z" }];
    const b: Doc[] = [{ id: "y" }, { id: "z" }, { id: "x" }];
    const merged = rrfMerge([a, b], { key: (d) => d.id });
    expect(merged).toHaveLength(3);
    expect(merged.map((m) => m.item.id)).toEqual(["y", "x", "z"]);
  });

  it("items absent from a list contribute 0 from that list (rank=-1)", () => {
    const a: Doc[] = [{ id: "x" }];
    const b: Doc[] = [{ id: "y" }];
    const merged = rrfMerge([a, b], { key: (d) => d.id });

    const x = merged.find((m) => m.item.id === "x")!;
    const y = merged.find((m) => m.item.id === "y")!;
    expect(x.ranks).toEqual([0, -1]);
    expect(y.ranks).toEqual([-1, 0]);
    expect(x.score).toBeCloseTo(1 / 61, 5);
    expect(y.score).toBeCloseTo(1 / 61, 5);
  });

  it("custom dampener k changes the score curve", () => {
    const a: Doc[] = [{ id: "x" }];
    const k = 10;
    const merged = rrfMerge([a], { key: (d) => d.id, k });
    expect(merged[0]!.score).toBeCloseTo(1 / 11, 5);
  });

  it("respects the limit cap", () => {
    const a: Doc[] = [
      { id: "a" },
      { id: "b" },
      { id: "c" },
      { id: "d" },
      { id: "e" },
    ];
    const merged = rrfMerge([a], { key: (d) => d.id, limit: 2 });
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.item.id)).toEqual(["a", "b"]);
  });

  it("tiebreaks by first-seen order when scores are identical", () => {
    // Two items, each appears once at rank 0 in their respective list.
    // Identical scores → tiebreak says the one seen first wins.
    const a: Doc[] = [{ id: "first" }];
    const b: Doc[] = [{ id: "second" }];
    const merged = rrfMerge([a, b], { key: (d) => d.id });
    expect(merged.map((m) => m.item.id)).toEqual(["first", "second"]);
  });

  it("preserves the first instance of an item when keys collide", () => {
    // Same id but different bodies — the first instance is the one whose
    // payload is kept.
    const a: Doc[] = [{ id: "x", body: "from-a" }];
    const b: Doc[] = [{ id: "x", body: "from-b" }];
    const merged = rrfMerge([a, b], { key: (d) => d.id });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.item.body).toBe("from-a");
  });

  it("handles empty rankings gracefully", () => {
    expect(rrfMerge([], { key: (d: Doc) => d.id })).toEqual([]);
    expect(rrfMerge([[]], { key: (d: Doc) => d.id })).toEqual([]);
    expect(rrfMerge([[], []], { key: (d: Doc) => d.id })).toEqual([]);
  });

  it("rounds the score to six decimal places", () => {
    const merged = rrfMerge([[{ id: "x" }]], { key: (d: Doc) => d.id });
    // Score should be Number().toFixed(6) → at most 6 fractional digits.
    const fractionalDigits = String(merged[0]!.score).split(".")[1] ?? "";
    expect(fractionalDigits.length).toBeLessThanOrEqual(6);
  });
});
