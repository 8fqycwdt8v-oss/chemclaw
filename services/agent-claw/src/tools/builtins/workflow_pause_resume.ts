// workflow_pause_resume — pause or resume a workflow run.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { pauseRun, resumeRun } from "../../core/workflows/client.js";
import { appendAudit } from "../../routes/admin/audit-log.js";

export const WorkflowPauseResumeIn = z.object({
  run_id: z.string().uuid(),
  action: z.enum(["pause", "resume"]),
});
export type WorkflowPauseResumeInput = z.infer<typeof WorkflowPauseResumeIn>;

export const WorkflowPauseResumeOut = z.object({
  run_id: z.string(),
  action: z.string(),
  applied: z.boolean(),
});
export type WorkflowPauseResumeOutput = z.infer<typeof WorkflowPauseResumeOut>;

export function buildWorkflowPauseResumeTool(pool: Pool) {
  return defineTool({
    id: "workflow_pause_resume",
    description:
      "Pause or resume a workflow run. Pause halts dispatching of new steps " +
      "(in-flight steps run to completion). Resume re-emits the current " +
      "cursor. Both actions append a workflow_event for the audit trail.",
    inputSchema: WorkflowPauseResumeIn,
    outputSchema: WorkflowPauseResumeOut,
    annotations: { readOnly: false },
    execute: async (ctx, input) => {
      const by = ctx.userEntraId;
      if (input.action === "pause") {
        await pauseRun(pool, input.run_id, by);
      } else {
        await resumeRun(pool, input.run_id, by);
      }
      await appendAudit(pool, {
        actor: by,
        action: `workflow.${input.action}`,
        target: input.run_id,
      }).catch(() => undefined);
      return { run_id: input.run_id, action: input.action, applied: true };
    },
  });
}
