// Tests for Phase E shadow-serving additions to PromptRegistry.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PromptRegistry } from "../../src/prompts/registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// PromptRegistry now wraps reads in withSystemContext (pool.connect → client.query).
// `pool.query` is a vi.fn() spy used by tests to set return values + assert on
// data-query call counts. BEGIN/SET LOCAL/COMMIT issued by the transaction
// wrapper bypass the spy entirely (silent no-ops), so test assertions like
// `toHaveBeenCalledOnce()` and `mockResolvedValueOnce` chains line up with
// the data queries only.
function makePool(overrides: Record<string, unknown> = {}) {
  const dataSpy = vi.fn();
  const isTxControl = (sql: unknown): boolean => {
    if (typeof sql !== "string") return false;
    const s = sql.toUpperCase().trim();
    return s.startsWith("BEGIN") || s.startsWith("COMMIT") ||
           s.startsWith("ROLLBACK") || s.includes("SET_CONFIG");
  };
  const queryDispatch = async (sql: unknown, ...args: unknown[]) => {
    if (isTxControl(sql)) return { rows: [], rowCount: 0 };
    return dataSpy(sql, ...args);
  };
  const client = { query: queryDispatch, release: vi.fn() };
  return {
    query: dataSpy,
    connect: vi.fn(async () => client),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PromptRegistry — shadow serving (Phase E)", () => {
  describe("getShadowPrompts", () => {
    it("returns shadow prompts when they exist", async () => {
      const pool = makePool();
      (pool.query).mockResolvedValue({
        rows: [
          { template: "Shadow T", version: 2, shadow_until: new Date("2030-01-01") },
        ],
      });

      const registry = new PromptRegistry(pool as never);
      const shadows = await registry.getShadowPrompts("agent.system");

      expect(shadows).toHaveLength(1);
      expect(shadows[0]!.version).toBe(2);
      expect(shadows[0]!.template).toBe("Shadow T");
    });

    it("returns empty array when no shadow prompts", async () => {
      const pool = makePool();
      (pool.query).mockResolvedValue({ rows: [] });

      const registry = new PromptRegistry(pool as never);
      const shadows = await registry.getShadowPrompts("agent.system");

      expect(shadows).toEqual([]);
    });
  });

  describe("recordShadowScore", () => {
    it("inserts a row without error", async () => {
      const pool = makePool();
      (pool.query).mockResolvedValue({});

      const registry = new PromptRegistry(pool as never);
      await expect(
        registry.recordShadowScore("agent.system", 2, "trace-id", 0.85, { analytical: 0.9 }),
      ).resolves.toBeUndefined();

      expect(pool.query).toHaveBeenCalledOnce();
      const sql = (pool.query).mock.calls[0]![0] as string;
      expect(sql).toContain("shadow_run_scores");
    });
  });

  describe("getShadowSummary", () => {
    it("returns null when no rows exist (run_count=0)", async () => {
      const pool = makePool();
      (pool.query)
        .mockResolvedValueOnce({ rows: [{ mean_score: 0.0, run_count: "0", latest_run_at: null }] })
        .mockResolvedValueOnce({ rows: [] });

      const registry = new PromptRegistry(pool as never);
      const summary = await registry.getShadowSummary("agent.system", 2);
      expect(summary).toBeNull();
    });

    it("returns summary when rows exist", async () => {
      const pool = makePool();
      (pool.query)
        .mockResolvedValueOnce({
          rows: [{ mean_score: 0.82, run_count: "15", latest_run_at: new Date("2025-04-01") }],
        })
        .mockResolvedValueOnce({ rows: [] });

      const registry = new PromptRegistry(pool as never);
      const summary = await registry.getShadowSummary("agent.system", 2);
      expect(summary).not.toBeNull();
      expect(summary!.meanScore).toBe(0.82);
      expect(summary!.runCount).toBe(15);
    });
  });

  describe("shouldAutoPromote", () => {
    it("returns true when shadow beats active by >= 0.05 and meets floor", async () => {
      const pool = makePool();
      const registry = new PromptRegistry(pool as never);

      // Mock getShadowSummary to return a good result.
      vi.spyOn(registry, "getShadowSummary").mockResolvedValue({
        promptName: "agent.system",
        version: 2,
        meanScore: 0.88,
        runCount: 50,
        perClassScores: { analytical: 0.90 },
        latestRunAt: new Date(),
      });

      const result = await registry.shouldAutoPromote(
        "agent.system", 2, 0.82, { analytical: 0.88 },
      );
      expect(result).toBe(true);
    });

    it("returns false when shadow is below absolute floor (0.80)", async () => {
      const pool = makePool();
      const registry = new PromptRegistry(pool as never);

      vi.spyOn(registry, "getShadowSummary").mockResolvedValue({
        promptName: "agent.system",
        version: 2,
        meanScore: 0.79,
        runCount: 50,
        perClassScores: null,
        latestRunAt: new Date(),
      });

      const result = await registry.shouldAutoPromote("agent.system", 2, 0.73, null);
      expect(result).toBe(false);
    });

    it("returns false when no summary available", async () => {
      const pool = makePool();
      const registry = new PromptRegistry(pool as never);

      vi.spyOn(registry, "getShadowSummary").mockResolvedValue(null);

      const result = await registry.shouldAutoPromote("agent.system", 2, 0.80, null);
      expect(result).toBe(false);
    });

    it("returns false when shadow does not beat active by 0.05", async () => {
      const pool = makePool();
      const registry = new PromptRegistry(pool as never);

      vi.spyOn(registry, "getShadowSummary").mockResolvedValue({
        promptName: "agent.system",
        version: 2,
        meanScore: 0.83,
        runCount: 50,
        perClassScores: null,
        latestRunAt: new Date(),
      });

      // active = 0.80; shadow = 0.83; delta = 0.03 < 0.05
      const result = await registry.shouldAutoPromote("agent.system", 2, 0.80, null);
      expect(result).toBe(false);
    });

    it("returns false when any per-class score drops > 0.02", async () => {
      const pool = makePool();
      const registry = new PromptRegistry(pool as never);

      vi.spyOn(registry, "getShadowSummary").mockResolvedValue({
        promptName: "agent.system",
        version: 2,
        meanScore: 0.90,
        runCount: 50,
        perClassScores: { analytical: 0.75, retrosynthesis: 0.92 },
        latestRunAt: new Date(),
      });

      // Active: analytical=0.80 → shadow=0.75 → drop=0.05 > 0.02 → false
      const result = await registry.shouldAutoPromote(
        "agent.system", 2, 0.84, { analytical: 0.80, retrosynthesis: 0.90 },
      );
      expect(result).toBe(false);
    });
  });
});
