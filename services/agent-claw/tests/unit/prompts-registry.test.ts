// Tests for the PromptRegistry (ported from legacy + cache TTL coverage).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PromptRegistry } from "../../src/prompts/registry.js";
import type { Pool, QueryResult } from "pg";

// ---------------------------------------------------------------------------
// Helpers — mock Pool
// ---------------------------------------------------------------------------

function makeMockPool(rows: { template: string; version: number }[]): Pool {
  const mockQuery = vi.fn().mockResolvedValue({ rows, rowCount: rows.length } as QueryResult);
  return { query: mockQuery } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PromptRegistry.getActive", () => {
  it("returns template and version for an active prompt", async () => {
    const pool = makeMockPool([{ template: "You are ChemClaw.", version: 2 }]);
    const registry = new PromptRegistry(pool);
    const result = await registry.getActive("agent.system");
    expect(result.template).toBe("You are ChemClaw.");
    expect(result.version).toBe(2);
  });

  it("throws if no active prompt is found", async () => {
    const pool = makeMockPool([]);
    const registry = new PromptRegistry(pool);
    await expect(registry.getActive("agent.system")).rejects.toThrow(
      /no active prompt registered/,
    );
  });

  it("queries with the correct prompt name", async () => {
    const pool = makeMockPool([{ template: "DR prompt.", version: 1 }]);
    const registry = new PromptRegistry(pool);
    await registry.getActive("agent.deep_research_mode");
    const mockQuery = (pool.query as ReturnType<typeof vi.fn>);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("prompt_registry"),
      ["agent.deep_research_mode"],
    );
  });

  it("serves from cache within TTL without hitting DB again", async () => {
    const pool = makeMockPool([{ template: "Cached prompt.", version: 1 }]);
    const registry = new PromptRegistry(pool);

    await registry.getActive("agent.system");
    await registry.getActive("agent.system"); // second call — should use cache

    const mockQuery = (pool.query as ReturnType<typeof vi.fn>);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("invalidate() clears the cache and forces a fresh DB query", async () => {
    const pool = makeMockPool([{ template: "Fresh prompt.", version: 3 }]);
    const registry = new PromptRegistry(pool);

    await registry.getActive("agent.system");
    registry.invalidate();
    await registry.getActive("agent.system");

    const mockQuery = (pool.query as ReturnType<typeof vi.fn>);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("cacheAgeMs returns null for uncached prompts", () => {
    const pool = makeMockPool([]);
    const registry = new PromptRegistry(pool);
    expect(registry.cacheAgeMs("agent.system")).toBeNull();
  });

  it("cacheAgeMs returns a non-negative value after a successful fetch", async () => {
    const pool = makeMockPool([{ template: "T", version: 1 }]);
    const registry = new PromptRegistry(pool);
    await registry.getActive("agent.system");
    const age = registry.cacheAgeMs("agent.system");
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
    // Should be less than 5s (it was just fetched).
    expect(age!).toBeLessThan(5000);
  });
});
