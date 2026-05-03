// promote_workflow_to_tool — admin-gate + schema tests.

import { describe, it, expect, vi } from "vitest";
import { buildPromoteWorkflowToToolTool } from "../../../src/tools/builtins/promote_workflow_to_tool.js";

// NOTE: arguments=arguments.length so the `undefined` case actually reaches
// the builtin (default param values fire on `undefined` passes).
function makeCtx(userEntraId: string | undefined): {
  userEntraId: string | undefined;
  scratchpad: Map<string, unknown>;
  seenFactIds: Set<string>;
} {
  return {
    userEntraId,
    scratchpad: new Map<string, unknown>([["seenFactIds", new Set<string>()]]),
    seenFactIds: new Set<string>(),
  };
}

const VALID_USER = "test@example.com";

function makePool(workflowExists = true, isAdminReturn = false): unknown {
  return {
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (/SELECT version FROM workflows/i.test(sql)) {
          return workflowExists ? { rows: [{ version: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/current_user_is_admin/i.test(sql)) {
          return { rows: [{ is_admin: isAdminReturn }], rowCount: 1 };
        }
        if (/INSERT INTO admin_audit_log/i.test(sql)) {
          return { rows: [{ id: "audit-1" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    }),
  };
}

describe("promote_workflow_to_tool", () => {
  it("schema requires snake_case tool_name", () => {
    const tool = buildPromoteWorkflowToToolTool(makePool() as never);
    expect(
      tool.inputSchema.safeParse({
        workflow_id: "11111111-1111-1111-1111-111111111111",
        tool_name: "BadName",
        description: "long-enough description here",
      }).success,
    ).toBe(false);
  });

  it("rejects non-private scope without admin role", async () => {
    const tool = buildPromoteWorkflowToToolTool(makePool(true, false) as never);
    await expect(
      tool.execute(makeCtx(VALID_USER), {
        workflow_id: "11111111-1111-1111-1111-111111111111",
        tool_name: "my_tool",
        description: "long-enough description",
        scope: "global",
      }),
    ).rejects.toThrow(/global_admin/);
  });

  it("requires scope_id when scope=org", async () => {
    const tool = buildPromoteWorkflowToToolTool(makePool(true, true) as never);
    await expect(
      tool.execute(makeCtx(VALID_USER), {
        workflow_id: "11111111-1111-1111-1111-111111111111",
        tool_name: "my_tool",
        description: "long-enough description",
        scope: "org",
      }),
    ).rejects.toThrow(/scope_id/);
  });

  it("rejects non-private scope when caller has no userEntraId", async () => {
    const tool = buildPromoteWorkflowToToolTool(makePool(true, true) as never);
    await expect(
      tool.execute(makeCtx(undefined), {
        workflow_id: "11111111-1111-1111-1111-111111111111",
        tool_name: "my_tool",
        description: "long-enough description",
        scope: "project",
        scope_id: "proj-1",
      }),
    ).rejects.toThrow(/real user identity/);
  });
});
