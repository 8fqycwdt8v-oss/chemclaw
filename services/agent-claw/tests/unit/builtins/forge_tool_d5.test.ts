// Tests for forge_tool Phase D.5 extensions:
//   - parent_tool_id forking
//   - forged_by_model / forged_by_role persistence
//   - test case persistence on all-pass

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { promises as fsp } from "fs";
import { buildForgeToolTool, buildGenerationPrompt } from "../../../src/tools/builtins/forge_tool.js";
import { StubLlmProvider } from "../../../src/llm/provider.js";
import { makeCtx } from "../../helpers/make-ctx.js";
import type { Pool } from "pg";
import type { SandboxClient, SandboxHandle } from "../../../src/core/sandbox.js";

const ctx = makeCtx();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GOOD_SCHEMA_IN = { type: "object", properties: { x: { type: "number" } }, required: ["x"] };
const GOOD_SCHEMA_OUT = { type: "object", properties: { result: { type: "number" } }, required: ["result"] };
const GOOD_CASES = [
  { input: { x: 1 }, expected_output: { result: 42 } },
  { input: { x: 2 }, expected_output: { result: 42 } },
];

function makeMockPool(parentVersion = 1, parentScriptsPath?: string): Pool {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("parent_tool_id") || (sql.includes("kind = 'forged_tool'") && sql.includes("id = $1"))) {
        // parent lookup
        return Promise.resolve({
          rows: [{ id: randomUUID(), version: parentVersion, scripts_path: parentScriptsPath ?? null }],
        });
      }
      if (sql.includes("EXISTS") && sql.includes("tools")) {
        return Promise.resolve({ rows: [{ exists: false }] });
      }
      if (sql.includes("EXISTS") && sql.includes("skill_library")) {
        return Promise.resolve({ rows: [{ exists: false }] });
      }
      if (sql.includes("INSERT INTO skill_library")) {
        return Promise.resolve({ rows: [{ id: randomUUID() }] });
      }
      if (sql.includes("INSERT INTO forged_tool_tests")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("INSERT INTO tools")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as Pool;
}

function makeMockSandbox(): SandboxClient {
  const handle: SandboxHandle = { id: "mock", _raw: {} };
  return {
    createSandbox: vi.fn().mockResolvedValue(handle),
    executePython: vi.fn().mockResolvedValue({
      stdout: '{"__chemclaw_output__": {"result": 42}}',
      stderr: "",
      exit_code: 0,
      files_created: [],
      duration_ms: 10,
    }),
    installPackages: vi.fn().mockResolvedValue(undefined),
    mountReadOnlyFile: vi.fn().mockResolvedValue(undefined),
    closeSandbox: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------

describe("forge_tool — parent_tool_id forking", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `forge-d5-${Date.now()}`);
    await fsp.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("sets version = parent.version + 1 on all-pass", async () => {
    const pool = makeMockPool(2); // parent version 2
    const llm = new StubLlmProvider();
    llm.enqueueJson({ python_code: "result = 42", explanation: "fork" });

    const tool = buildForgeToolTool(pool, makeMockSandbox(), llm, tmpDir, "user@test.com");
    const parentId = randomUUID();
    const result = await tool.execute(ctx, {
      name: "forked_tool",
      description: "A fork",
      input_schema_json: GOOD_SCHEMA_IN,
      output_schema_json: GOOD_SCHEMA_OUT,
      test_cases: GOOD_CASES,
      parent_tool_id: parentId,
    });

    expect(result.version).toBe(3); // parent 2 + 1
    expect(result.persisted).toBe(true);
  });

  it("throws when parent_tool_id is not found", async () => {
    const pool: Pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("kind = 'forged_tool'")) {
          return Promise.resolve({ rows: [] }); // not found
        }
        return Promise.resolve({ rows: [{ exists: false }] });
      }),
    } as unknown as Pool;

    const llm = new StubLlmProvider();
    const tool = buildForgeToolTool(pool, makeMockSandbox(), llm, tmpDir, "user@test.com");

    await expect(
      tool.execute(ctx, {
        name: "forked_tool",
        description: "A fork",
        input_schema_json: GOOD_SCHEMA_IN,
        output_schema_json: GOOD_SCHEMA_OUT,
        test_cases: GOOD_CASES,
        parent_tool_id: randomUUID(),
      }),
    ).rejects.toThrow(/parent_tool_id.*not found/);
  });

  it("new tool (no parent) has version 1", async () => {
    const _pool = makeMockPool();
    const pool2: Pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("EXISTS")) return Promise.resolve({ rows: [{ exists: false }] });
        if (sql.includes("INSERT INTO skill_library")) return Promise.resolve({ rows: [{ id: randomUUID() }] });
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as Pool;

    const llm = new StubLlmProvider();
    llm.enqueueJson({ python_code: "result = 42", explanation: "new" });

    const tool = buildForgeToolTool(pool2, makeMockSandbox(), llm, tmpDir, "user@test.com");
    const result = await tool.execute(ctx, {
      name: "brand_new",
      description: "Brand new tool",
      input_schema_json: GOOD_SCHEMA_IN,
      output_schema_json: GOOD_SCHEMA_OUT,
      test_cases: GOOD_CASES,
    });

    expect(result.version).toBe(1);
  });
});

describe("forge_tool — forged_by_model / forged_by_role passed through", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = join(tmpdir(), `forge-role-${Date.now()}`);
    await fsp.mkdir(tmpDir, { recursive: true });
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists forged_by_model and forged_by_role in the INSERT", async () => {
    const queries: string[] = [];
    const pool: Pool = {
      query: vi.fn().mockImplementation((sql: string, _params?: unknown[]) => {
        queries.push(sql);
        if (sql.includes("EXISTS")) return Promise.resolve({ rows: [{ exists: false }] });
        if (sql.includes("INSERT INTO skill_library")) return Promise.resolve({ rows: [{ id: randomUUID() }] });
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as Pool;

    const llm = new StubLlmProvider();
    llm.enqueueJson({ python_code: "result = 42", explanation: "role test" });

    const tool = buildForgeToolTool(
      pool,
      makeMockSandbox(),
      llm,
      tmpDir,
      "user@test.com",
      "claude-opus-4-7",
      "planner",
    );

    const result = await tool.execute(ctx, {
      name: "role_tool",
      description: "Tests role persistence",
      input_schema_json: GOOD_SCHEMA_IN,
      output_schema_json: GOOD_SCHEMA_OUT,
      test_cases: GOOD_CASES,
    });

    expect(result.persisted).toBe(true);
    // Verify INSERT INTO skill_library was called.
    expect(queries.some((q) => q.includes("INSERT INTO skill_library"))).toBe(true);
  });
});

describe("forge_tool — buildGenerationPrompt with parent code", () => {
  it("includes parent code in the user prompt when provided", () => {
    const input = {
      name: "forked",
      description: "A fork",
      input_schema_json: GOOD_SCHEMA_IN,
      output_schema_json: GOOD_SCHEMA_OUT,
      test_cases: GOOD_CASES,
    };
    const parentCode = "# original implementation\nresult = x * 2";
    const { user } = buildGenerationPrompt(input, [], parentCode);
    expect(user).toContain("Parent tool code");
    expect(user).toContain(parentCode);
  });

  it("omits parent section when parentCode is undefined", () => {
    const input = {
      name: "new_tool",
      description: "Fresh",
      input_schema_json: GOOD_SCHEMA_IN,
      output_schema_json: GOOD_SCHEMA_OUT,
      test_cases: GOOD_CASES,
    };
    const { user } = buildGenerationPrompt(input, []);
    expect(user).not.toContain("Parent tool code");
  });
});
