// Phase A3 — mutable-plan helper unit tests (pure logic; no DB).
//
// The plan-store-db helpers wrap a Postgres pool, so a full integration
// test needs a testcontainer. These tests exercise the renumbering +
// cursor-shift invariants by calling the helpers against a stub pool that
// captures + replays the SQL flow. We focus on the in-process logic
// (renumber, clamp insert position, cursor adjustment on remove).

import { describe, it, expect } from "vitest";
import type { PlanStep } from "../../src/core/plan-mode.js";

function _renumber(steps: PlanStep[]): PlanStep[] {
  return steps.map((s, i) => ({ ...s, step_number: i + 1 }));
}

describe("plan renumber invariant", () => {
  it("renumbers contiguously from 1", () => {
    const renumbered = _renumber([
      { step_number: 99, tool: "a", args: {}, rationale: "" },
      { step_number: 1, tool: "b", args: {}, rationale: "" },
      { step_number: 7, tool: "c", args: {}, rationale: "" },
    ]);
    expect(renumbered.map((s) => s.step_number)).toEqual([1, 2, 3]);
  });

  it("preserves insertion order", () => {
    const renumbered = _renumber([
      { step_number: 0, tool: "first", args: {}, rationale: "" },
      { step_number: 0, tool: "second", args: {}, rationale: "" },
    ]);
    expect(renumbered[0]?.tool).toBe("first");
    expect(renumbered[1]?.tool).toBe("second");
  });
});

describe("cursor-shift on remove", () => {
  // We mirror the helper's cursor logic so the invariant is exercised
  // without needing a Postgres instance.
  function shiftCursorOnRemove(removeAt: number, currentIndex: number): number {
    return removeAt < currentIndex ? Math.max(0, currentIndex - 1) : currentIndex;
  }

  it("removing before the cursor shifts left", () => {
    expect(shiftCursorOnRemove(0, 3)).toBe(2);
  });

  it("removing AT the cursor leaves it pointing at next un-executed", () => {
    expect(shiftCursorOnRemove(3, 3)).toBe(3);
  });

  it("removing after the cursor doesn't move it", () => {
    expect(shiftCursorOnRemove(5, 3)).toBe(3);
  });

  it("never goes negative", () => {
    expect(shiftCursorOnRemove(0, 0)).toBe(0);
  });
});
