// workflow_modify — patch a paused workflow's remaining definition.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { modifyDefinition } from "../../core/workflows/client.js";
import { appendAudit } from "../../routes/admin/audit-log.js";

const MAX_DEFINITION_BYTES = 256 * 1024;

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
      const definitionBytes = Buffer.byteLength(
        JSON.stringify(input.new_definition), "utf8",
      );
      if (definitionBytes > MAX_DEFINITION_BYTES) {
        throw new Error(
          `new_definition is ${definitionBytes} bytes; max is ${MAX_DEFINITION_BYTES}`,
        );
      }
      const actor = ctx.userEntraId ?? "__agent__";
      await modifyDefinition(
        pool, input.run_id, input.new_definition, actor, input.justification,
      );
      await appendAudit(pool, {
        actor,
        action: "workflow.modify",
        target: input.run_id,
        reason: input.justification,
      }).catch(() => undefined);
      return { run_id: input.run_id, applied: true };
    },
  });
}
