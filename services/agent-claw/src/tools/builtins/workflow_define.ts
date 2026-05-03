// workflow_define — create or version a workflow from a JSON DSL.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { defineWorkflow } from "../../core/workflows/client.js";

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
      const rec = await defineWorkflow(
        pool, input.definition, ctx.userEntraId ?? "__agent__",
      );
      return {
        workflow_id: rec.id,
        name: rec.name,
        version: rec.version,
        created_at: rec.created_at,
      };
    },
  });
}
