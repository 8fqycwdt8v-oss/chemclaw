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

// SkillLoader.loadFromDb now uses withSystemContext (pool.connect → client.query
// inside a BEGIN/SET LOCAL/COMMIT transaction). The stub pool needs a
// `connect()` that returns a client whose `.query()` returns the configured
// rows for skill_library SELECTs and silently no-ops for transaction-control
// SQL.
const _txControl = (sql: unknown): boolean => {
  if (typeof sql !== "string") return false;
  const s = sql.toUpperCase().trim();
  return s.startsWith("BEGIN") || s.startsWith("COMMIT") ||
         s.startsWith("ROLLBACK") || s.includes("SET_CONFIG");
};

function makeStubPool(rows: StubRow[]): Pool {
  const dataResult = {
    rows,
    rowCount: rows.length,
    command: "SELECT",
    oid: 0,
    fields: [],
  } as unknown as QueryResult;
  const empty = { rows: [], rowCount: 0, command: "", oid: 0, fields: [] } as unknown as QueryResult;
  const clientQuery = async (sql: unknown) => (_txControl(sql) ? empty : dataResult);
  return {
    query: clientQuery,
    connect: async () => ({ query: clientQuery, release: () => {} }),
  } as unknown as Pool;
}

function makeFailingPool(): Pool {
  const fail = async (sql: unknown) => {
    // Let transaction control through so the rollback path doesn't crash on
    // a missing BEGIN; the actual data SELECT is what should throw.
    if (_txControl(sql)) return { rows: [], rowCount: 0 } as unknown as QueryResult;
    throw new Error("DB unavailable");
  };
  return {
    query: fail,
    connect: async () => ({ query: fail, release: () => {} }),
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
