// Tests for SkillLoader.loadFromDb — Phase C.3 DB integration

import { describe, it, expect, beforeEach } from "vitest";
import { SkillLoader } from "../../src/core/skills.js";
import type { Pool, QueryResult } from "pg";

// ---------------------------------------------------------------------------
// Minimal stub Pool that returns rows for skill_library queries.
// ---------------------------------------------------------------------------

interface StubRow {
  id: string;
  name: string;
  prompt_md: string;
  kind: string;
  version: number;
}

function makeStubPool(rows: StubRow[]): Pool {
  return {
    query: async <T = StubRow>(_sql: string, _params?: unknown[]): Promise<QueryResult<T>> => {
      return {
        rows: rows as unknown as T[],
        rowCount: rows.length,
        command: "SELECT",
        oid: 0,
        fields: [],
      };
    },
  } as unknown as Pool;
}

function makeFailingPool(): Pool {
  return {
    query: async () => {
      throw new Error("DB unavailable");
    },
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillLoader.loadFromDb", () => {
  let loader: SkillLoader;

  beforeEach(() => {
    loader = new SkillLoader();
  });

  it("loads active DB skills when no filesystem skills conflict", async () => {
    const pool = makeStubPool([
      { id: "uuid-1", name: "Yield Optimizer", prompt_md: "## Yield\n\nOptimize yield.", kind: "prompt", version: 1 },
      { id: "uuid-2", name: "Retro Planner", prompt_md: "## Retro\n\nPlan retro.", kind: "prompt", version: 1 },
    ]);

    const result = await loader.loadFromDb(pool);
    expect(result.loaded).toBe(2);
    expect(result.hidden).toBe(0);
    expect(loader.has("yield_optimizer")).toBe(true);
    expect(loader.has("retro_planner")).toBe(true);
  });

  it("sanitizes skill names to lowercase snake_case", async () => {
    const pool = makeStubPool([
      { id: "uuid-3", name: "My Cool Skill!", prompt_md: "body", kind: "prompt", version: 1 },
    ]);
    await loader.loadFromDb(pool);
    expect(loader.has("my_cool_skill_")).toBe(true);
  });

  it("hides DB skills that conflict with filesystem skills", async () => {
    // Pre-populate a filesystem skill manually.
    (loader as unknown as { _skills: Map<string, unknown> })._skills.set("yield_optimizer", {
      id: "yield_optimizer",
      description: "FS skill",
      version: 1,
      tools: [],
      promptBody: "filesystem wins",
    });

    const pool = makeStubPool([
      { id: "uuid-4", name: "yield_optimizer", prompt_md: "DB version", kind: "prompt", version: 1 },
    ]);

    const result = await loader.loadFromDb(pool);
    expect(result.loaded).toBe(0);
    expect(result.hidden).toBe(1);
    // Filesystem skill is still there.
    expect(loader.get("yield_optimizer")?.promptBody).toBe("filesystem wins");
  });

  it("returns loaded:0 hidden:0 when DB is unavailable (non-fatal)", async () => {
    const pool = makeFailingPool();
    const result = await loader.loadFromDb(pool);
    expect(result.loaded).toBe(0);
    expect(result.hidden).toBe(0);
  });

  it("returns loaded:0 when DB returns no rows", async () => {
    const pool = makeStubPool([]);
    const result = await loader.loadFromDb(pool);
    expect(result.loaded).toBe(0);
    expect(result.hidden).toBe(0);
  });

  it("DB-loaded skills appear in the catalog list", async () => {
    const pool = makeStubPool([
      { id: "uuid-5", name: "Spectrum Analyzer", prompt_md: "## Spec\n\nAnalyze.", kind: "prompt", version: 2 },
    ]);
    await loader.loadFromDb(pool);
    const catalog = loader.list();
    const skill = catalog.find((s) => s.id === "spectrum_analyzer");
    expect(skill).toBeDefined();
    expect(skill?.version).toBe(2);
    expect(skill?.description).toContain("DB-backed skill");
  });
});
