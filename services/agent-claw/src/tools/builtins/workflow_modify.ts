// workflow_modify — patch a paused workflow's remaining definition.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { modifyDefinition } from "../../core/workflows/client.js";

export const WorkflowModifyIn = z.object({
  run_id: z.string().uuid(),
  new_definition: z.record(z.string(), z.unknown()),
  justification: z.string().min(10).max(2000),
});
export type WorkflowModifyInput = z.infer<typeof WorkflowModifyIn>;

export const WorkflowModifyOut = z.object({
  run_id: z.string(),
  applied: z.boolean(),
});
export type WorkflowModifyOutput = z.infer<typeof WorkflowModifyOut>;

export function buildWorkflowModifyTool(pool: Pool) {
  return defineTool({
    id: "workflow_modify",
    description:
      "Patch a paused workflow's remaining definition. Records before/after " +
      "snapshots and justification into workflow_modifications + " +
      "workflow_events. Run must be in status='paused' before this call. " +
      "The modified definition is also bi-temporally stored as a new " +
      "workflows row, so a future replay reproduces the patched run.",
    inputSchema: WorkflowModifyIn,
    outputSchema: WorkflowModifyOut,
    annotations: { readOnly: false },
    execute: async (ctx, input) => {
      await modifyDefinition(
        pool, input.run_id, input.new_definition,
        ctx.userEntraId ?? "__agent__", input.justification,
      );
      return { run_id: input.run_id, applied: true };
    },
  });
}
