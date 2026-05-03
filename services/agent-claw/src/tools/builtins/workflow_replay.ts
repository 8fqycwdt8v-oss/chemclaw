// workflow_replay — replay a finished run with optional input overrides.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { replayRun } from "../../core/workflows/client.js";
import { appendAudit } from "../../routes/admin/audit-log.js";

export const WorkflowReplayIn = z.object({
  parent_run_id: z.string().uuid(),
  input_override: z.record(z.string(), z.unknown()).optional(),
});
export type WorkflowReplayInput = z.infer<typeof WorkflowReplayIn>;

export const WorkflowReplayOut = z.object({
  run_id: z.string(),
  parent_run_id: z.string(),
});
export type WorkflowReplayOutput = z.infer<typeof WorkflowReplayOut>;

export function buildWorkflowReplayTool(pool: Pool) {
  return defineTool({
    id: "workflow_replay",
    description:
      "Replay a finished workflow run. The new run shares the workflow " +
      "definition (or its modified-via-workflow_modify successor) and gets " +
      "parent_run_id set so the lineage is queryable. If input_override is " +
      "passed, the parent run's input is overridden; otherwise the parent's " +
      "input is reused for a deterministic re-run.",
    inputSchema: WorkflowReplayIn,
    outputSchema: WorkflowReplayOut,
    annotations: { readOnly: false },
    execute: async (ctx, input) => {
      const actor = ctx.userEntraId ?? "__agent__";
      const runId = await replayRun(
        pool, input.parent_run_id,
        input.input_override ?? null,
        actor,
      );
      await appendAudit(pool, {
        actor,
        action: "workflow.replay",
        target: runId,
        afterValue: { parent_run_id: input.parent_run_id },
      }).catch(() => undefined);
      return { run_id: runId, parent_run_id: input.parent_run_id };
    },
  });
}
