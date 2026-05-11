// Phase B1 — wall-clock budget gate unit tests.

import { describe, it, expect } from "vitest";
import { Budget } from "../../src/core/budget.js";

describe("Budget — wall-clock gate", () => {
  it("isWallClockExpired returns false when no cap is set", () => {
    const b = new Budget({ maxSteps: 10 });
    expect(b.isWallClockExpired()).toBe(false);
  });

  it("isWallClockExpired returns false before the cap", () => {
    const b = new Budget({ maxSteps: 10, maxWallClockMs: 60_000 });
    expect(b.isWallClockExpired()).toBe(false);
  });

  it("isWallClockExpired returns true once the cap is reached", async () => {
    const b = new Budget({ maxSteps: 10, maxWallClockMs: 1 });
    // Sleep 10ms to ensure we cross the 1ms threshold.
    await new Promise((r) => setTimeout(r, 10));
    expect(b.isWallClockExpired()).toBe(true);
  });

  it("elapsedMs increases monotonically", async () => {
    const b = new Budget({ maxSteps: 10 });
    const before = b.elapsedMs;
    await new Promise((r) => setTimeout(r, 5));
    expect(b.elapsedMs).toBeGreaterThan(before);
  });
});
