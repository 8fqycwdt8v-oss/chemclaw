// Tests for ToolRegistry.toolsForRole() — Phase D.5 weak-from-strong.

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool } from "../../src/tools/tool.js";
import type { ModelRole } from "../../src/llm/provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(id: string, description = "a tool"): Tool {
  return {
    id,
    description,
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    execute: async () => ({}),
  };
}

function makeRegistry(
  entries: Array<{ id: string; forgedByRole?: ModelRole | null; forgedByModel?: string | null }>,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const entry of entries) {
    registry.upsert(makeTool(entry.id), {
      forgedByRole: entry.forgedByRole ?? null,
      forgedByModel: entry.forgedByModel ?? null,
    });
  }
  return registry;
}

// ---------------------------------------------------------------------------

describe("ToolRegistry.toolsForRole — weak-from-strong ordering", () => {
  it("surfacing planner-forged tools first for executor caller", () => {
    const registry = makeRegistry([
      { id: "normal_tool" },
      { id: "planner_tool", forgedByRole: "planner", forgedByModel: "claude-opus-4-7" },
      { id: "executor_tool", forgedByRole: "executor" },
    ]);

    const tools = registry.toolsForRole("executor");
    // planner-forged appears before normal and executor-forged (executor == caller tier).
    const ids = tools.map((t) => t.id);
    expect(ids.indexOf("planner_tool")).toBeLessThan(ids.indexOf("normal_tool"));
    expect(ids.indexOf("planner_tool")).toBeLessThan(ids.indexOf("executor_tool"));
  });

  it("adds stronger-author hint to the description", () => {
    const registry = makeRegistry([
      { id: "opus_tool", forgedByRole: "planner", forgedByModel: "claude-opus-4-7" },
    ]);

    const tools = registry.toolsForRole("compactor");
    const opusTool = tools.find((t) => t.id === "opus_tool");
    expect(opusTool?.description).toContain("stronger-model author");
    expect(opusTool?.description).toContain("claude-opus-4-7");
  });

  it("does not demote tools forged by the same role", () => {
    const registry = makeRegistry([
      { id: "executor_tool", forgedByRole: "executor" },
      { id: "normal_tool" },
    ]);

    const tools = registry.toolsForRole("executor");
    // executor_tool is same tier — not surfaced as 'stronger' — no hint in description.
    const execTool = tools.find((t) => t.id === "executor_tool");
    expect(execTool?.description).not.toContain("stronger-model author");
  });

  it("compactor sees planner and executor forged tools before judge-forged", () => {
    const registry = makeRegistry([
      { id: "judge_tool", forgedByRole: "judge" },
      { id: "planner_tool", forgedByRole: "planner" },
      { id: "exec_tool", forgedByRole: "executor" },
    ]);

    const tools = registry.toolsForRole("compactor");
    const ids = tools.map((t) => t.id);
    // Both planner and executor are stronger than compactor.
    expect(ids.indexOf("planner_tool")).toBeLessThan(ids.indexOf("judge_tool"));
    expect(ids.indexOf("exec_tool")).toBeLessThan(ids.indexOf("judge_tool"));
    // Planner (tier 4) > executor (tier 3) within stronger group.
    expect(ids.indexOf("planner_tool")).toBeLessThan(ids.indexOf("exec_tool"));
  });

  it("returns all tools even when no role metadata is set", () => {
    const registry = makeRegistry([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const tools = registry.toolsForRole("judge");
    expect(tools).toHaveLength(3);
  });
});
