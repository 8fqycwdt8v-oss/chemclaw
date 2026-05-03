// workflow_run — start a run of an existing workflow.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { startRun } from "../../core/workflows/client.js";

export const WorkflowRunIn = z.object({
  workflow_id: z.string().uuid(),
  input: z.record(z.string(), z.unknown()).default({}),
  session_id: z.string().uuid().optional(),
});
export type WorkflowRunInput = z.infer<typeof WorkflowRunIn>;

export const WorkflowRunOut = z.object({
  run_id: z.string(),
  status: z.literal("running"),
});
export type WorkflowRunOutput = z.infer<typeof WorkflowRunOut>;

export function buildWorkflowRunTool(pool: Pool) {
  return defineTool({
    id: "workflow_run",
    description:
      "Start a run of an existing workflow with the given input payload. " +
      "Returns run_id immediately — the workflow_engine consumes events " +
      "asynchronously. Poll progress via workflow_inspect.",
    inputSchema: WorkflowRunIn,
    outputSchema: WorkflowRunOut,
    annotations: { readOnly: false },
    execute: async (ctx, input) => {
      const runId = await startRun(
        pool, input.workflow_id, input.input ?? {},
        ctx.userEntraId ?? "__agent__",
        input.session_id ?? null,
      );
      return { run_id: runId, status: "running" as const };
    },
  });
}
