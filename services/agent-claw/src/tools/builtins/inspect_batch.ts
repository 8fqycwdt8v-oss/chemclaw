// inspect_batch — read current progress of a batch enqueued via enqueue_batch.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { inspectBatch } from "../../db/queue.js";

export const InspectBatchIn = z.object({
  batch_id: z.string().uuid(),
  sample_n: z.number().int().min(0).max(50).default(5),
});
export type InspectBatchInput = z.infer<typeof InspectBatchIn>;

export const InspectBatchOut = z.object({
  batch_id: z.string(),
  name: z.string().nullable(),
  kind: z.string().nullable(),
  total: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  cancelled: z.number(),
  pending: z.number(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
  sample_results: z.array(z.object({
    task_kind: z.string(),
    status: z.string(),
    result: z.unknown(),
  })),
});
export type InspectBatchOutput = z.infer<typeof InspectBatchOut>;

export function buildInspectBatchTool(pool: Pool) {
  return defineTool({
    id: "inspect_batch",
    description:
      "Get progress of a queued batch — counts of pending/succeeded/failed/" +
      "cancelled tasks plus a sample of recent results. Pass batch_id from " +
      "enqueue_batch.",
    inputSchema: InspectBatchIn,
    outputSchema: InspectBatchOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      const summary = await inspectBatch(pool, input.batch_id, input.sample_n);
      const pending = Math.max(
        0,
        summary.total - summary.succeeded - summary.failed - summary.cancelled,
      );
      return {
        ...summary,
        pending,
      };
    },
  });
}
