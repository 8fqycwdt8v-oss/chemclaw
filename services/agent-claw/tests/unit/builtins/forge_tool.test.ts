// Tests for tools/builtins/forge_tool.ts — 4-stage Forjador meta-tool.
// E2B sandbox, LLM, and DB are fully mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { promises as fsp } from "fs";
import { randomUUID } from "crypto";
import {
  buildForgeToolTool,
  validateJsonSchema,
  valuesMatch,
  PROTECTED_TOOL_NAMES,
  buildGenerationPrompt,
} from "../../../src/tools/builtins/forge_tool.js";
import type { SandboxClient, SandboxHandle } from "../../../src/core/sandbox.js";
import { StubLlmProvider } from "../../../src/llm/provider.js";
import { makeCtx } from "../../helpers/make-ctx.js";
import type { Pool } from "pg";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockPool(
  existsResult = false,
  skillExistsResult = false,
): Pool {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("EXISTS") && sql.includes("skill_library")) {
        return Promise.resolve({ rows: [{ exists: skillExistsResult }] });
      }
      if (sql.includes("EXISTS")) {
        return Promise.resolve({ rows: [{ exists: existsResult }] });
      }
      // INSERT queries return a row id.
      if (sql.includes("INSERT INTO skill_library")) {
        return Promise.resolve({ rows: [{ id: randomUUID() }] });
      }
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as Pool;
}

function makeMockSandboxClient(opts?: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  shouldThrow?: boolean;
}): SandboxClient {
  const handle: SandboxHandle = { id: "mock-sandbox", _raw: {} };
  const exec = opts?.shouldThrow
    ? vi.fn().mockRejectedValue(new Error("sandbox error"))
    : vi.fn().mockResolvedValue({
        stdout: opts?.stdout ?? '{"__chemclaw_output__": {"result": 42}}',
        stderr: opts?.stderr ?? "",
        exit_code: opts?.exitCode ?? 0,
        files_created: [],
        duration_ms: 50,
      });

  return {
    createSandbox: vi.fn().mockResolvedValue(handle),
    executePython: exec,
    installPackages: vi.fn().mockResolvedValue(undefined),
    mountReadOnlyFile: vi.fn().mockResolvedValue(undefined),
    closeSandbox: vi.fn().mockResolvedValue(undefined),
  };
}

function makeLlm(pythonCode = "result = 42"): StubLlmProvider {
  const llm = new StubLlmProvider();
  llm.enqueueJson({ python_code: pythonCode, explanation: "simple implementation" });
  return llm;
}

const GOOD_INPUT_SCHEMA = {
  type: "object",
  properties: { x: { type: "number" } },
  required: ["x"],
};
const GOOD_OUTPUT_SCHEMA = {
  type: "object",
  properties: { result: { type: "number" } },
  required: ["result"],
};
const GOOD_TEST_CASES = [
  { input: { x: 1 }, expected_output: { result: 42 } },
  { input: { x: 2 }, expected_output: { result: 42 } },
];

const ctx = makeCtx();

// ---------------------------------------------------------------------------
// validateJsonSchema
// ---------------------------------------------------------------------------

describe("validateJsonSchema", () => {
  it("accepts a valid object schema", () => {
    expect(() =>
      validateJsonSchema({ type: "object", properties: { x: { type: "number" } } }),
    ).not.toThrow();
  });

  it("rejects non-object top-level type", () => {
    expect(() => validateJsonSchema({ type: "array" })).toThrow(/top-level schema type/);
  });

  it("rejects null schema", () => {
    expect(() => validateJsonSchema(null)).toThrow();
  });

  it("rejects schema where properties is not an object", () => {
    expect(() =>
      validateJsonSchema({ type: "object", properties: "bad" }),
    ).toThrow(/properties/);
  });
});

// ---------------------------------------------------------------------------
// valuesMatch
// ---------------------------------------------------------------------------

describe("valuesMatch", () => {
  it("returns true for identical primitives", () => {
    expect(valuesMatch(42, 42)).toBe(true);
    expect(valuesMatch("hello", "hello")).toBe(true);
    expect(valuesMatch(true, true)).toBe(true);
  });

  it("returns false for different primitives", () => {
    expect(valuesMatch(1, 2)).toBe(false);
    expect(valuesMatch("a", "b")).toBe(false);
  });

  it("uses tolerance for numbers", () => {
    expect(valuesMatch(1.0, 1.05, 0.1)).toBe(true);
    expect(valuesMatch(1.0, 1.2, 0.1)).toBe(false);
  });

  it("recursively compares objects", () => {
    expect(valuesMatch({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(valuesMatch({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("returns false when expected is null", () => {
    expect(valuesMatch(null, 42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PROTECTED_TOOL_NAMES
// ---------------------------------------------------------------------------

describe("PROTECTED_TOOL_NAMES", () => {
  it("contains forge_tool and run_program", () => {
    expect(PROTECTED_TOOL_NAMES.has("forge_tool")).toBe(true);
    expect(PROTECTED_TOOL_NAMES.has("run_program")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildGenerationPrompt
// ---------------------------------------------------------------------------

describe("buildGenerationPrompt", () => {
  it("includes tool name and description in the user prompt", () => {
    const input = {
      name: "my_tool",
      description: "Does something cool",
      input_schema_json: GOOD_INPUT_SCHEMA,
      output_schema_json: GOOD_OUTPUT_SCHEMA,
      test_cases: GOOD_TEST_CASES,
    };
    const { system, user } = buildGenerationPrompt(input, ["canonicalize_smiles"]);
    expect(user).toContain("my_tool");
    expect(user).toContain("Does something cool");
    expect(system).toContain("canonicalize_smiles");
  });

  it("includes implementation_hint when provided", () => {
    const input = {
      name: "my_tool",
      description: "Does something cool",
      input_schema_json: GOOD_INPUT_SCHEMA,
      output_schema_json: GOOD_OUTPUT_SCHEMA,
      test_cases: GOOD_TEST_CASES,
      implementation_hint: "Use numpy for this",
    };
    const { user } = buildGenerationPrompt(input, []);
    expect(user).toContain("Use numpy for this");
  });
});

// ---------------------------------------------------------------------------
// buildForgeToolTool — input validation
// ---------------------------------------------------------------------------

describe("buildForgeToolTool — input schema validation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `forge-test-${Date.now()}`);
  });

  it("rejects name that doesn't match slug pattern", async () => {
    const tool = buildForgeToolTool(
      makeMockPool(),
      makeMockSandboxClient(),
      makeLlm(),
      tmpDir,
      "user@test.com",
    );
    const parsed = tool.inputSchema.safeParse({
      name: "My Tool!",
      description: "desc",
      input_schema_json: GOOD_INPUT_SCHEMA,
      output_schema_json: GOOD_OUTPUT_SCHEMA,
      test_cases: GOOD_TEST_CASES,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects fewer than 2 test cases", async () => {
    const tool = buildForgeToolTool(
      makeMockPool(),
      makeMockSandboxClient(),
      makeLlm(),
      tmpDir,
      "user@test.com",
    );
    const parsed = tool.inputSchema.safeParse({
      name: "my_tool",
      description: "desc",
      input_schema_json: GOOD_INPUT_SCHEMA,
      output_schema_json: GOOD_OUTPUT_SCHEMA,
      test_cases: [{ input: {}, expected_output: {} }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects more than 10 test cases", async () => {
    const tool = buildForgeToolTool(
      makeMockPool(),
      makeMockSandboxClient(),
      makeLlm(),
      tmpDir,
      "user@test.com",
    );
    const parsed = tool.inputSchema.safeParse({
      name: "my_tool",
      description: "desc",
      input_schema_json: GOOD_INPUT_SCHEMA,
      output_schema_json: GOOD_OUTPUT_SCHEMA,
      test_cases: Array.from({ length: 11 }, () => ({ input: {}, expected_output: {} })),
    });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildForgeToolTool — loop guard
// ---------------------------------------------------------------------------

describe("buildForgeToolTool — loop guard", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `forge-test-${Date.now()}`);
  });

  it("rejects forge_tool as the name", async () => {
    const tool = buildForgeToolTool(
      makeMockPool(),
      makeMockSandboxClient(),
      makeLlm(),
      tmpDir,
      "user@test.com",
    );
    await expect(
      tool.execute(ctx, {
        name: "forge_tool",
        description: "desc",
        input_schema_json: GOOD_INPUT_SCHEMA,
        output_schema_json: GOOD_OUTPUT_SCHEMA,
        test_cases: GOOD_TEST_CASES,
      }),
    ).rejects.toThrow(/protected tool/);
  });

  it("rejects run_program as the name", async () => {
    const tool = buildForgeToolTool(
      makeMockPool(),
      makeMockSandboxClient(),
      makeLlm(),
      tmpDir,
      "user@test.com",
    );
    await expect(
      tool.execute(ctx, {
        name: "run_program",
        description: "desc",
        input_schema_json: GOOD_INPUT_SCHEMA,
        output_schema_json: GOOD_OUTPUT_SCHEMA,
        test_cases: GOOD_TEST_CASES,
      }),
    ).rejects.toThrow(/protected tool/);
  });
});

// ---------------------------------------------------------------------------
// buildForgeToolTool — name conflict
// ---------------------------------------------------------------------------

describe("buildForgeToolTool — name conflict", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `forge-test-${Date.now()}`);
  });

  it("rejects when name already exists in tools table", async () => {
    const pool = makeMockPool(true /* toolExists */, false);
    const tool = buildForgeToolTool(
      pool,
      makeMockSandboxClient(),
      makeLlm(),
      tmpDir,
      "user@test.com",
    );
    await expect(
      tool.execute(ctx, {
        name: "existing_tool",
        description: "desc",
        input_schema_json: GOOD_INPUT_SCHEMA,
        output_schema_json: GOOD_OUTPUT_SCHEMA,
        test_cases: GOOD_TEST_CASES,
      }),
    ).rejects.toThrow(/already exists/);
  });
});

// ---------------------------------------------------------------------------
// buildForgeToolTool — test case failures
// ---------------------------------------------------------------------------

describe("buildForgeToolTool — test case failures not persisted", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `forge-test-${Date.now()}`);
  });

  it("returns failures and persisted=false when a test case fails", async () => {
    // LLM generates code, but sandbox returns wrong output.
    const sandbox = makeMockSandboxClient({
      stdout: '{"__chemclaw_output__": {"result": 999}}', // wrong value
    });
    const tool = buildForgeToolTool(
      makeMockPool(),
      sandbox,
      makeLlm("result = 999"),
      tmpDir,
      "user@test.com",
    );

    const result = await tool.execute(ctx, {
      name: "test_fail_tool",
      description: "fails",
      input_schema_json: GOOD_INPUT_SCHEMA,
      output_schema_json: GOOD_OUTPUT_SCHEMA,
      test_cases: [
        { input: { x: 1 }, expected_output: { result: 42 } },
        { input: { x: 2 }, expected_output: { result: 42 } },
      ],
    });

    expect(result.persisted).toBe(false);
    expect(result.validation.failed).toBeGreaterThan(0);
    expect(result.validation.failures.length).toBeGreaterThan(0);
    expect(result.skill_library_row_id).toBeUndefined();
  });

  it("returns failures and persisted=false when sandbox exits non-zero", async () => {
    const sandbox = makeMockSandboxClient({ exitCode: 1, stderr: "SyntaxError", stdout: "" });
    const tool = buildForgeToolTool(
      makeMockPool(),
      sandbox,
      makeLlm("invalid python [[["),
      tmpDir,
      "user@test.com",
    );

    const result = await tool.execute(ctx, {
      name: "test_crash_tool",
      description: "crashes",
      input_schema_json: GOOD_INPUT_SCHEMA,
      output_schema_json: GOOD_OUTPUT_SCHEMA,
      test_cases: GOOD_TEST_CASES,
    });

    expect(result.persisted).toBe(false);
    expect(result.validation.failed).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildForgeToolTool — happy path / persistence
// ---------------------------------------------------------------------------

describe("buildForgeToolTool — happy path persistence", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `forge-test-${Date.now()}`);
    await fsp.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists tool when all test cases pass", async () => {
    const pool = makeMockPool(false, false);
    const sandbox = makeMockSandboxClient({
      stdout: '{"__chemclaw_output__": {"result": 42}}',
    });
    const tool = buildForgeToolTool(pool, sandbox, makeLlm("result = 42"), tmpDir, "user@test.com");

    const result = await tool.execute(ctx, {
      name: "my_new_tool",
      description: "does stuff",
      input_schema_json: GOOD_INPUT_SCHEMA,
      output_schema_json: GOOD_OUTPUT_SCHEMA,
      test_cases: GOOD_TEST_CASES,
    });

    expect(result.persisted).toBe(true);
    expect(result.validation.passed).toBe(2);
    expect(result.validation.failed).toBe(0);
    expect(result.skill_library_row_id).toBeTruthy();
    expect(result.tool_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("writes Python code to disk when all tests pass", async () => {
    const pool = makeMockPool(false, false);
    const sandbox = makeMockSandboxClient({
      stdout: '{"__chemclaw_output__": {"result": 42}}',
    });
    const pythonCode = "# my unique tool code\nresult = 42";
    const tool = buildForgeToolTool(pool, sandbox, makeLlm(pythonCode), tmpDir, "user@test.com");

    const result = await tool.execute(ctx, {
      name: "disk_write_tool",
      description: "writes to disk",
      input_schema_json: GOOD_INPUT_SCHEMA,
      output_schema_json: GOOD_OUTPUT_SCHEMA,
      test_cases: GOOD_TEST_CASES,
    });

    // Verify the file exists on disk.
    const files = await fsp.readdir(tmpDir);
    expect(files.some((f) => f.endsWith(".py"))).toBe(true);
    // Verify content matches the generated code.
    const pyFile = files.find((f) => f.endsWith(".py"))!;
    const content = await fsp.readFile(join(tmpDir, pyFile), "utf-8");
    expect(content).toBe(pythonCode);
    expect(result.persisted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildForgeToolTool — LLM failure
// ---------------------------------------------------------------------------

describe("buildForgeToolTool — LLM failure", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `forge-test-${Date.now()}`);
  });

  it("throws when LLM does not return python_code", async () => {
    const llm = new StubLlmProvider();
    llm.enqueueJson({ explanation: "no code" }); // missing python_code

    const tool = buildForgeToolTool(
      makeMockPool(),
      makeMockSandboxClient(),
      llm,
      tmpDir,
      "user@test.com",
    );

    await expect(
      tool.execute(ctx, {
        name: "bad_llm_tool",
        description: "desc",
        input_schema_json: GOOD_INPUT_SCHEMA,
        output_schema_json: GOOD_OUTPUT_SCHEMA,
        test_cases: GOOD_TEST_CASES,
      }),
    ).rejects.toThrow(/python_code/);
  });
});
