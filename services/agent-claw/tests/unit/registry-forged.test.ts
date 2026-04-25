// Tests for ToolRegistry: source='forged' tool loading (Phase D.1).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { SandboxClient, SandboxHandle } from "../../src/core/sandbox.js";
import { makeCtx } from "../helpers/make-ctx.js";
import type { Pool } from "pg";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockSandboxClient(opts?: {
  stdout?: string;
  exitCode?: number;
}): SandboxClient {
  const handle: SandboxHandle = { id: "mock-sandbox", _raw: {} };
  return {
    createSandbox: vi.fn().mockResolvedValue(handle),
    executePython: vi.fn().mockResolvedValue({
      stdout: opts?.stdout ?? '{"__chemclaw_output__": {"value": 99}}',
      stderr: "",
      exit_code: opts?.exitCode ?? 0,
      files_created: [],
      duration_ms: 10,
    }),
    installPackages: vi.fn().mockResolvedValue(undefined),
    mountReadOnlyFile: vi.fn().mockResolvedValue(undefined),
    closeSandbox: vi.fn().mockResolvedValue(undefined),
  };
}

// Minimal forged tool DB row.
function makeForgedRow(scriptsPath: string | null = "/forged/test.py") {
  return {
    name: "my_forged_tool",
    source: "forged" as const,
    schema_json: {
      type: "object",
      properties: { input_val: { type: "number" } },
      required: ["input_val"],
    },
    mcp_url: null,
    mcp_endpoint: null,
    description: "A forged tool for testing",
    scripts_path: scriptsPath,
  };
}

const ctx = makeCtx();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ToolRegistry — setSandboxClient", () => {
  it("returns this for chaining", () => {
    const registry = new ToolRegistry();
    const sandbox = makeMockSandboxClient();
    const result = registry.setSandboxClient(sandbox);
    expect(result).toBe(registry);
  });
});

describe("ToolRegistry.loadFromDb — source='forged' skipped without sandbox", () => {
  it("skips forged tool when setSandboxClient was not called", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [makeForgedRow()] }),
    } as unknown as Pool;

    const registry = new ToolRegistry();
    // No setSandboxClient call.
    await registry.loadFromDb(pool);

    // Tool should NOT be registered (skipped with warning).
    expect(registry.get("my_forged_tool")).toBeUndefined();
  });

  it("skips forged tool with null scripts_path", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [makeForgedRow(null)] }),
    } as unknown as Pool;

    const registry = new ToolRegistry();
    registry.setSandboxClient(makeMockSandboxClient());
    await registry.loadFromDb(pool);

    expect(registry.get("my_forged_tool")).toBeUndefined();
  });
});

describe("ToolRegistry.loadFromDb — source='forged' registered with sandbox", () => {
  it("registers a forged tool when sandbox and scripts_path are present", async () => {
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { promises: fsp } = await import("fs");

    // Write a real Python file to a temp path.
    const dir = join(tmpdir(), `registry-test-${Date.now()}`);
    await fsp.mkdir(dir, { recursive: true });
    const pyPath = join(dir, "test.py");
    await fsp.writeFile(pyPath, "value = 99\n", "utf-8");

    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [makeForgedRow(pyPath)] }),
    } as unknown as Pool;

    const registry = new ToolRegistry();
    registry.setSandboxClient(makeMockSandboxClient());
    await registry.loadFromDb(pool);

    const tool = registry.get("my_forged_tool");
    expect(tool).toBeDefined();
    expect(tool!.id).toBe("my_forged_tool");
    expect(tool!.description).toBe("A forged tool for testing");

    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("forged tool execute calls sandbox.executePython", async () => {
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { promises: fsp } = await import("fs");

    const dir = join(tmpdir(), `registry-exec-test-${Date.now()}`);
    await fsp.mkdir(dir, { recursive: true });
    const pyPath = join(dir, "exec.py");
    await fsp.writeFile(pyPath, "value = 99\n", "utf-8");

    const execFn = vi.fn().mockResolvedValue({
      stdout: '{"__chemclaw_output__": {"value": 99}}',
      stderr: "",
      exit_code: 0,
      files_created: [],
      duration_ms: 10,
    });

    const sandbox = {
      ...makeMockSandboxClient(),
      executePython: execFn,
    };

    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [makeForgedRow(pyPath)] }),
    } as unknown as Pool;

    const registry = new ToolRegistry();
    registry.setSandboxClient(sandbox);
    await registry.loadFromDb(pool);

    const tool = registry.get("my_forged_tool")!;
    await tool.execute(ctx, { input_val: 5 });

    expect(execFn).toHaveBeenCalled();

    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("forged tool throws when scripts_path file is missing at execute time", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [makeForgedRow("/nonexistent/path/tool.py")],
      }),
    } as unknown as Pool;

    const registry = new ToolRegistry();
    registry.setSandboxClient(makeMockSandboxClient());
    await registry.loadFromDb(pool);

    const tool = registry.get("my_forged_tool")!;
    expect(tool).toBeDefined();

    await expect(tool.execute(ctx, { input_val: 1 })).rejects.toThrow(
      /failed to read forged tool code/,
    );
  });
});
