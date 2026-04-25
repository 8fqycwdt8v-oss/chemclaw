// Tests for tools/builtins/run_program.ts — programmatic tool calling.
// All sandbox and DB interactions are mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildRunProgramTool,
  preflightCheck,
  parseOutputs,
  wrapCode,
  buildStubLibrary,
  clearStubCache,
} from "../../../src/tools/builtins/run_program.js";
import type { SandboxClient, SandboxHandle } from "../../../src/core/sandbox.js";
import { makeCtx } from "../../helpers/make-ctx.js";
import type { Pool } from "pg";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeMockSandboxClient(
  overrides: Partial<{
    executePython: ReturnType<typeof vi.fn>;
    createSandbox: ReturnType<typeof vi.fn>;
    closeSandbox: ReturnType<typeof vi.fn>;
    mountReadOnlyFile: ReturnType<typeof vi.fn>;
    installPackages: ReturnType<typeof vi.fn>;
  }> = {},
): SandboxClient {
  const handle: SandboxHandle = { id: "mock-sandbox", _raw: {} };
  return {
    createSandbox: overrides.createSandbox ?? vi.fn().mockResolvedValue(handle),
    executePython:
      overrides.executePython ??
      vi.fn().mockResolvedValue({
        stdout: '{"__chemclaw_output__": {"result": 42}}',
        stderr: "",
        exit_code: 0,
        files_created: [],
        duration_ms: 100,
      }),
    installPackages: overrides.installPackages ?? vi.fn().mockResolvedValue(undefined),
    mountReadOnlyFile: overrides.mountReadOnlyFile ?? vi.fn().mockResolvedValue(undefined),
    closeSandbox: overrides.closeSandbox ?? vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockPool(rows: unknown[] = []): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Pool;
}

const ctx = makeCtx();

beforeEach(() => {
  clearStubCache();
});

// ---------------------------------------------------------------------------
// preflightCheck
// ---------------------------------------------------------------------------

describe("preflightCheck", () => {
  it("passes code with no chemclaw calls", () => {
    const result = preflightCheck("x = 1 + 2");
    expect(result.ok).toBe(true);
    expect(result.unknownHelpers).toHaveLength(0);
  });

  it("passes code using a known helper", () => {
    const result = preflightCheck("chemclaw.canonicalize_smiles('CCO')");
    expect(result.ok).toBe(true);
    expect(result.unknownHelpers).toHaveLength(0);
  });

  it("rejects code calling an unknown helper", () => {
    const result = preflightCheck("chemclaw.unknown_helper(x)");
    expect(result.ok).toBe(false);
    expect(result.unknownHelpers).toContain("unknown_helper");
  });

  it("passes all known helpers", () => {
    const code = [
      "chemclaw.fetch_document('doc-id')",
      "chemclaw.query_kg('sparql')",
      "chemclaw.find_similar_reactions('CC>>CO')",
      "chemclaw.canonicalize_smiles('CCO')",
      "chemclaw.embed_text('hello')",
      "chemclaw.compute_drfp('CC>>CO')",
    ].join("\n");
    const result = preflightCheck(code);
    expect(result.ok).toBe(true);
  });

  it("reports multiple unknown helpers", () => {
    const result = preflightCheck("chemclaw.foo()\nchemclaw.bar()");
    expect(result.ok).toBe(false);
    expect(result.unknownHelpers).toContain("foo");
    expect(result.unknownHelpers).toContain("bar");
  });
});

// ---------------------------------------------------------------------------
// parseOutputs
// ---------------------------------------------------------------------------

describe("parseOutputs", () => {
  it("parses __chemclaw_output__ from a single stdout line", () => {
    const stdout = '{"__chemclaw_output__": {"x": 42, "y": "hello"}}';
    const result = parseOutputs(stdout);
    expect(result).toEqual({ x: 42, y: "hello" });
  });

  it("finds the output line among other stdout lines", () => {
    const stdout = [
      "computing...",
      '{"__chemclaw_output__": {"result": [1,2,3]}}',
      "done",
    ].join("\n");
    const result = parseOutputs(stdout);
    expect(result).toEqual({ result: [1, 2, 3] });
  });

  it("returns null when no output line is present", () => {
    const result = parseOutputs("just some text\nno output marker");
    expect(result).toBeNull();
  });

  it("returns null when the JSON is malformed", () => {
    const result = parseOutputs('{"__chemclaw_output__": broken}');
    expect(result).toBeNull();
  });

  it("returns null when __chemclaw_output__ value is not an object", () => {
    const result = parseOutputs('{"__chemclaw_output__": [1,2,3]}');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// wrapCode
// ---------------------------------------------------------------------------

describe("wrapCode", () => {
  it("wraps user code with input injection and output collection", () => {
    const wrapped = wrapCode("z = x + y", { x: 1, y: 2 }, ["z"]);
    // JSON.stringify produces compact JSON — check for key presence without spacing.
    expect(wrapped).toContain('"x"');
    expect(wrapped).toContain('"y"');
    expect(wrapped).toContain("z = x + y");
    expect(wrapped).toContain("__chemclaw_output__");
    expect(wrapped).toContain('"z"');
  });

  it("handles empty inputs", () => {
    const wrapped = wrapCode("result = 100", {}, ["result"]);
    expect(wrapped).toContain("result = 100");
    expect(wrapped).toContain("__chemclaw_output__");
  });
});

// ---------------------------------------------------------------------------
// buildStubLibrary
// ---------------------------------------------------------------------------

describe("buildStubLibrary", () => {
  it("generates valid Python with all six helper functions", () => {
    const stub = buildStubLibrary({});
    for (const fn of ["fetch_document", "query_kg", "find_similar_reactions", "canonicalize_smiles", "embed_text", "compute_drfp"]) {
      expect(stub).toContain(`def ${fn}`);
    }
  });

  it("uses provided MCP URLs in the stub", () => {
    const stub = buildStubLibrary({ "mcp-rdkit": "http://rdkit.internal:9001" });
    expect(stub).toContain("http://rdkit.internal:9001");
  });

  it("falls back to localhost defaults when URL not provided", () => {
    const stub = buildStubLibrary({});
    expect(stub).toContain("localhost:8001"); // rdkit default
    expect(stub).toContain("localhost:8002"); // drfp default
  });
});

// ---------------------------------------------------------------------------
// buildRunProgramTool — happy path
// ---------------------------------------------------------------------------

describe("buildRunProgramTool — happy path", () => {
  it("executes code and returns parsed outputs", async () => {
    const pool = makeMockPool([]);
    const sandbox = makeMockSandboxClient();
    const tool = buildRunProgramTool(pool, sandbox);

    const result = await tool.execute(ctx, {
      python_code: "result = 42",
      inputs: {},
      expected_outputs: ["result"],
      reason: "test execution",
    });

    expect(result.outputs).toEqual({ result: 42 });
    expect(result.stderr).toBe("");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("mounts the chemclaw stub before executing", async () => {
    const pool = makeMockPool([]);
    const mountFn = vi.fn().mockResolvedValue(undefined);
    const sandbox = makeMockSandboxClient({ mountReadOnlyFile: mountFn });
    const tool = buildRunProgramTool(pool, sandbox);

    await tool.execute(ctx, {
      python_code: "x = 1",
      inputs: {},
      expected_outputs: ["x"],
      reason: "test mount",
    });

    expect(mountFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Buffer),
      "/sandbox/chemclaw/__init__.py",
    );
  });

  it("calls closeSandbox in finally block on success", async () => {
    const pool = makeMockPool([]);
    const closeFn = vi.fn().mockResolvedValue(undefined);
    const sandbox = makeMockSandboxClient({ closeSandbox: closeFn });
    const tool = buildRunProgramTool(pool, sandbox);

    await tool.execute(ctx, {
      python_code: "x = 1",
      inputs: {},
      expected_outputs: ["x"],
      reason: "test close",
    });

    expect(closeFn).toHaveBeenCalledOnce();
  });

  it("calls closeSandbox even when executePython throws", async () => {
    const pool = makeMockPool([]);
    const closeFn = vi.fn().mockResolvedValue(undefined);
    const sandbox = makeMockSandboxClient({
      executePython: vi.fn().mockRejectedValue(new Error("sandbox crash")),
      closeSandbox: closeFn,
    });
    const tool = buildRunProgramTool(pool, sandbox);

    await expect(
      tool.execute(ctx, {
        python_code: "x = 1",
        inputs: {},
        expected_outputs: ["x"],
        reason: "crash test",
      }),
    ).rejects.toThrow("sandbox crash");

    expect(closeFn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// buildRunProgramTool — pre-flight rejection
// ---------------------------------------------------------------------------

describe("buildRunProgramTool — pre-flight rejection", () => {
  it("rejects code calling an unknown chemclaw helper", async () => {
    const pool = makeMockPool([]);
    const sandbox = makeMockSandboxClient();
    const tool = buildRunProgramTool(pool, sandbox);

    await expect(
      tool.execute(ctx, {
        python_code: "chemclaw.hack_the_planet()",
        inputs: {},
        expected_outputs: ["result"],
        reason: "test unknown helper",
      }),
    ).rejects.toThrow(/unknown chemclaw helpers/);
  });
});

// ---------------------------------------------------------------------------
// buildRunProgramTool — input validation
// ---------------------------------------------------------------------------

describe("buildRunProgramTool — input validation", () => {
  it("rejects empty python_code", () => {
    const pool = makeMockPool([]);
    const sandbox = makeMockSandboxClient();
    const tool = buildRunProgramTool(pool, sandbox);
    const parsed = tool.inputSchema.safeParse({
      python_code: "",
      inputs: {},
      expected_outputs: ["x"],
      reason: "test",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects python_code exceeding 50_000 chars", () => {
    const pool = makeMockPool([]);
    const sandbox = makeMockSandboxClient();
    const tool = buildRunProgramTool(pool, sandbox);
    const parsed = tool.inputSchema.safeParse({
      python_code: "x" + "x".repeat(50_001),
      inputs: {},
      expected_outputs: ["x"],
      reason: "test",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects missing reason", () => {
    const pool = makeMockPool([]);
    const sandbox = makeMockSandboxClient();
    const tool = buildRunProgramTool(pool, sandbox);
    const parsed = tool.inputSchema.safeParse({
      python_code: "x = 1",
      inputs: {},
      expected_outputs: ["x"],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects empty expected_outputs", () => {
    const pool = makeMockPool([]);
    const sandbox = makeMockSandboxClient();
    const tool = buildRunProgramTool(pool, sandbox);
    const parsed = tool.inputSchema.safeParse({
      python_code: "x = 1",
      inputs: {},
      expected_outputs: [],
      reason: "test",
    });
    expect(parsed.success).toBe(false);
  });
});
