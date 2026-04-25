// Tests for tools/builtins/induce_forged_tool_from_trace.ts — Phase D.5.
// Langfuse trace API is mocked throughout.

import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  buildInduceForgedToolFromTraceTool,
  type LangfuseTrace,
  type LangfuseTraceReader,
} from "../../../src/tools/builtins/induce_forged_tool_from_trace.js";
import { StubLlmProvider } from "../../../src/llm/provider.js";
import { makeCtx } from "../../helpers/make-ctx.js";
import type { Pool } from "pg";
import type { SandboxClient, SandboxHandle } from "../../../src/core/sandbox.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockPool(existsOk = true): Pool {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
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
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as Pool;
}

function makeMockSandbox(stdout = '{"__chemclaw_output__": {"result": 42}}'): SandboxClient {
  const handle: SandboxHandle = { id: "mock", _raw: {} };
  return {
    createSandbox: vi.fn().mockResolvedValue(handle),
    executePython: vi.fn().mockResolvedValue({
      stdout,
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

function makeTrace(eventCount = 2): LangfuseTrace {
  return {
    id: "trace-123",
    tool_events: Array.from({ length: eventCount }, (_, i) => ({
      tool_id: `tool_${i}`,
      input: { x: i },
      output: { result: i * 2 },
      timestamp: new Date().toISOString(),
    })),
  };
}

function makeTraceReader(trace: LangfuseTrace): LangfuseTraceReader {
  return async (_traceId: string) => trace;
}

const ctx = makeCtx();
const GOOD_SCHEMA = { type: "object", properties: { result: { type: "number" } } };

// ---------------------------------------------------------------------------

describe("buildInduceForgedToolFromTraceTool — happy path", () => {
  it("returns trace_id and tool_events_found", async () => {
    const trace = makeTrace(2);
    const llm = new StubLlmProvider();
    // LLM returns the generalisation spec + python code.
    llm.enqueueJson({
      input_schema_json: { type: "object", properties: { x: { type: "number" } } },
      output_schema_json: GOOD_SCHEMA,
      test_cases: [
        { input: { x: 0 }, expected_output: { result: 0 } },
        { input: { x: 1 }, expected_output: { result: 2 } },
        { input: { x: 2 }, expected_output: { result: 4 } },
      ],
    });
    // forge_tool's LLM call (generate).
    llm.enqueueJson({ python_code: "result = x * 2", explanation: "simple" });

    const tool = buildInduceForgedToolFromTraceTool(
      makeMockPool(),
      makeMockSandbox(),
      llm,
      join(tmpdir(), `induce-test-${Date.now()}`),
      "user@test.com",
      makeTraceReader(trace),
    );

    const result = await tool.execute(ctx, {
      trace_id: "trace-123",
      name: "double_x",
      description: "Doubles x",
    });

    expect(result.trace_id).toBe("trace-123");
    expect(result.tool_events_found).toBe(2);
    expect(result.forge_result).toBeTruthy();
  });

  it("throws when trace has no tool events", async () => {
    const emptyTrace = makeTrace(0);
    const llm = new StubLlmProvider();

    const tool = buildInduceForgedToolFromTraceTool(
      makeMockPool(),
      makeMockSandbox(),
      llm,
      join(tmpdir(), `induce-test-${Date.now()}`),
      "user@test.com",
      makeTraceReader(emptyTrace),
    );

    await expect(
      tool.execute(ctx, { trace_id: "trace-empty", name: "empty_tool", description: "empty" }),
    ).rejects.toThrow(/no tool-call events/);
  });
});

describe("buildInduceForgedToolFromTraceTool — LLM failures", () => {
  it("throws when LLM omits input_schema_json", async () => {
    const trace = makeTrace(1);
    const llm = new StubLlmProvider();
    llm.enqueueJson({ output_schema_json: GOOD_SCHEMA, test_cases: [{ input: {}, expected_output: {} }, { input: {}, expected_output: {} }] });

    const tool = buildInduceForgedToolFromTraceTool(
      makeMockPool(),
      makeMockSandbox(),
      llm,
      join(tmpdir(), `induce-test-${Date.now()}`),
      "user@test.com",
      makeTraceReader(trace),
    );

    await expect(
      tool.execute(ctx, { trace_id: "t", name: "no_input_schema", description: "d" }),
    ).rejects.toThrow(/input_schema_json/);
  });

  it("throws when LLM returns fewer than 2 test cases", async () => {
    const trace = makeTrace(1);
    const llm = new StubLlmProvider();
    llm.enqueueJson({
      input_schema_json: { type: "object", properties: {} },
      output_schema_json: GOOD_SCHEMA,
      test_cases: [{ input: {}, expected_output: { result: 1 } }],
    });

    const tool = buildInduceForgedToolFromTraceTool(
      makeMockPool(),
      makeMockSandbox(),
      llm,
      join(tmpdir(), `induce-test-${Date.now()}`),
      "user@test.com",
      makeTraceReader(trace),
    );

    await expect(
      tool.execute(ctx, { trace_id: "t", name: "few_tests", description: "d" }),
    ).rejects.toThrow(/at least 2 test_cases/);
  });

  it("throws when LLM returns invalid schema", async () => {
    const trace = makeTrace(1);
    const llm = new StubLlmProvider();
    llm.enqueueJson({
      input_schema_json: { type: "array" }, // wrong top-level type
      output_schema_json: GOOD_SCHEMA,
      test_cases: [
        { input: {}, expected_output: { result: 1 } },
        { input: {}, expected_output: { result: 2 } },
      ],
    });

    const tool = buildInduceForgedToolFromTraceTool(
      makeMockPool(),
      makeMockSandbox(),
      llm,
      join(tmpdir(), `induce-test-${Date.now()}`),
      "user@test.com",
      makeTraceReader(trace),
    );

    await expect(
      tool.execute(ctx, { trace_id: "t", name: "bad_schema", description: "d" }),
    ).rejects.toThrow(/schema validation/);
  });
});
