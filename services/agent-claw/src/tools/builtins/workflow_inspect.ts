// workflow_inspect — read current state + last N events of a run.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { inspectRun } from "../../core/workflows/client.js";

export const WorkflowInspectIn = z.object({
  run_id: z.string().uuid(),
  event_limit: z.number().int().min(1).max(500).default(50),
});
export type WorkflowInspectInput = z.infer<typeof WorkflowInspectIn>;

export const WorkflowInspectOut = z.object({
  run: z.object({
    id: z.string(),
    workflow_id: z.string(),
    parent_run_id: z.string().nullable(),
    session_id: z.string().nullable(),
    status: z.string(),
    input: z.record(z.string(), z.unknown()),
    output: z.record(z.string(), z.unknown()).nullable(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    paused_at: z.string().nullable(),
    created_by: z.string(),
    created_at: z.string(),
  }),
  state: z.object({
    current_step: z.string().nullable(),
    scope: z.unknown(),
    cursor: z.unknown(),
  }).nullable(),
  events: z.array(z.object({
    id: z.number(),
    run_id: z.string(),
    seq: z.number(),
    kind: z.string(),
    step_id: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
    created_at: z.string(),
  })),
});
export type WorkflowInspectOutput = z.infer<typeof WorkflowInspectOut>;

export function buildWorkflowInspectTool(pool: Pool) {
  return defineTool({
    id: "workflow_inspect",
    description:
      "Get the current state, last N events, and outstanding step of a workflow run. " +
      "Read-only; use this to diagnose stalls, audit step outcomes, or build " +
      "progress UIs. Returns the run row, the materialized state row, and " +
      "the most recent N events (default 50).",
    inputSchema: WorkflowInspectIn,
    outputSchema: WorkflowInspectOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      return await inspectRun(pool, input.run_id, input.event_limit ?? 50);
    },
  });
}
