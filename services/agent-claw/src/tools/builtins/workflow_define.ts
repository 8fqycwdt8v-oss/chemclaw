// workflow_define — create or version a workflow from a JSON DSL.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { defineWorkflow } from "../../core/workflows/client.js";
import { appendAudit } from "../../routes/admin/audit-log.js";

// Cap untrusted JSON definitions at 256 KB to bound memory + DB write size.
// 256 KB is well above any reasonable hand-authored workflow.
const MAX_DEFINITION_BYTES = 256 * 1024;

export const WorkflowDefineIn = z.object({
  definition: z.record(z.string(), z.unknown()).describe(
    "JSON workflow definition: { name, description?, steps: [...], outputs?: {...} }. " +
      "See WorkflowDefinition Zod schema in core/workflows/types.ts for the exact shape.",
  ),
});
export type WorkflowDefineInput = z.infer<typeof WorkflowDefineIn>;

export const WorkflowDefineOut = z.object({
  workflow_id: z.string(),
  name: z.string(),
  version: z.number().int(),
  created_at: z.string(),
});
export type WorkflowDefineOutput = z.infer<typeof WorkflowDefineOut>;

export function buildWorkflowDefineTool(pool: Pool) {
  return defineTool({
    id: "workflow_define",
    description:
      "Create or version a workflow from a JSON DSL. Validates against the " +
      "WorkflowDefinition schema. Each call to this tool with an existing name " +
      "bumps the version and closes the previous live row (bi-temporal). " +
      "Returns workflow_id + version.",
    inputSchema: WorkflowDefineIn,
    outputSchema: WorkflowDefineOut,
    annotations: { readOnly: false },
    execute: async (ctx, input) => {
      const definitionBytes = Buffer.byteLength(JSON.stringify(input.definition), "utf8");
      if (definitionBytes > MAX_DEFINITION_BYTES) {
        throw new Error(
          `workflow definition is ${definitionBytes} bytes; max is ${MAX_DEFINITION_BYTES}`,
        );
      }
      const actor = ctx.userEntraId;
      const rec = await defineWorkflow(pool, input.definition, actor);
      await appendAudit(pool, {
        actor,
        action: "workflow.define",
        target: rec.id,
        afterValue: { name: rec.name, version: rec.version },
      }).catch(() => undefined);  // never block the call on audit-log failures
      return {
        workflow_id: rec.id,
        name: rec.name,
        version: rec.version,
        created_at: rec.created_at,
      };
    },
  });
}
