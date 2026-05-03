// Smoke + boundary tests for the six workflow_* builtins.

import { describe, it, expect, vi, afterEach } from "vitest";

import { buildWorkflowDefineTool } from "../../../src/tools/builtins/workflow_define.js";
import { buildWorkflowRunTool } from "../../../src/tools/builtins/workflow_run.js";
import { buildWorkflowInspectTool } from "../../../src/tools/builtins/workflow_inspect.js";
import { buildWorkflowPauseResumeTool } from "../../../src/tools/builtins/workflow_pause_resume.js";
import { buildWorkflowModifyTool } from "../../../src/tools/builtins/workflow_modify.js";
import { buildWorkflowReplayTool } from "../../../src/tools/builtins/workflow_replay.js";

function makeCtx() {
  return {
    userEntraId: "test@example.com",
    scratchpad: new Map<string, unknown>([["seenFactIds", new Set<string>()]]),
    seenFactIds: new Set<string>(),
  };
}

function makePool(): unknown {
  return {
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("workflow_define", () => {
  it("schema accepts a non-empty object as definition", () => {
    const tool = buildWorkflowDefineTool(makePool() as never);
    expect(
      tool.inputSchema.safeParse({ definition: { name: "x", steps: [] } }).success,
    ).toBe(true);
  });

  it("rejects definitions over 256 KB", async () => {
    const tool = buildWorkflowDefineTool(makePool() as never);
    const huge = "x".repeat(300_000);
    await expect(
      tool.execute(makeCtx(), { definition: { junk: huge } }),
    ).rejects.toThrow(/max is/);
  });
});

describe("workflow_run", () => {
  it("schema requires a workflow_id UUID", () => {
    const tool = buildWorkflowRunTool(makePool() as never);
    expect(tool.inputSchema.safeParse({ workflow_id: "not-a-uuid" }).success).toBe(false);
  });
});

describe("workflow_inspect", () => {
  it("schema accepts a UUID + default event_limit", () => {
    const tool = buildWorkflowInspectTool(makePool() as never);
    expect(
      tool.inputSchema.safeParse({ run_id: "11111111-1111-1111-1111-111111111111" }).success,
    ).toBe(true);
  });
});

describe("workflow_pause_resume", () => {
  it("schema rejects unknown action", () => {
    const tool = buildWorkflowPauseResumeTool(makePool() as never);
    expect(
      tool.inputSchema.safeParse({
        run_id: "11111111-1111-1111-1111-111111111111", action: "halt",
      }).success,
    ).toBe(false);
  });
});

describe("workflow_modify", () => {
  it("schema requires a long-enough justification", () => {
    const tool = buildWorkflowModifyTool(makePool() as never);
    expect(
      tool.inputSchema.safeParse({
        run_id: "11111111-1111-1111-1111-111111111111",
        new_definition: { name: "x", steps: [] },
        justification: "short",
      }).success,
    ).toBe(false);
  });

  it("rejects oversize new_definition", async () => {
    const tool = buildWorkflowModifyTool(makePool() as never);
    const huge = "x".repeat(300_000);
    await expect(
      tool.execute(makeCtx(), {
        run_id: "11111111-1111-1111-1111-111111111111",
        new_definition: { junk: huge },
        justification: "this is a long-enough justification for the audit trail",
      }),
    ).rejects.toThrow(/max is/);
  });
});

describe("workflow_replay", () => {
  it("schema accepts parent_run_id only", () => {
    const tool = buildWorkflowReplayTool(makePool() as never);
    expect(
      tool.inputSchema.safeParse({
        parent_run_id: "11111111-1111-1111-1111-111111111111",
      }).success,
    ).toBe(true);
  });
});
