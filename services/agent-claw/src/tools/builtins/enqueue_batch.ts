// enqueue_batch — push a batch of QM / genchem / classifier tasks to the queue.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { createBatch, enqueueRows } from "../../db/queue.js";
import { appendAudit } from "../../routes/admin/audit-log.js";
import { getLogger } from "../../observability/logger.js";

const log = getLogger("enqueue_batch");

const TaskKind = z.enum([
  "qm_single_point",
  "qm_geometry_opt",
  "qm_frequencies",
  "qm_fukui",
  "qm_crest_conformers",
  "genchem_scaffold",
  "genchem_bioisostere",
]);

export const EnqueueBatchIn = z.object({
  name: z.string().min(1).max(200),
  task_kind: TaskKind,
  payloads: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
  priority: z.number().int().min(0).max(1000).default(100),
});
export type EnqueueBatchInput = z.infer<typeof EnqueueBatchIn>;

export const EnqueueBatchOut = z.object({
  batch_id: z.string(),
  task_kind: z.string(),
  total_requested: z.number(),
  inserted: z.number(),
  duplicates: z.number(),
});
export type EnqueueBatchOutput = z.infer<typeof EnqueueBatchOut>;

export function buildEnqueueBatchTool(pool: Pool) {
  return defineTool({
    id: "enqueue_batch",
    description:
      "Enqueue a batch of QM / genchem / classifier tasks. Returns batch_id " +
      "for monitoring via inspect_batch. Idempotent — re-enqueuing the same " +
      "(task_kind, payload) within the cluster is a no-op (returned in " +
      "`duplicates`). Use to fan out chemspace screens or large library " +
      "scoring runs.",
    inputSchema: EnqueueBatchIn,
    outputSchema: EnqueueBatchOut,
    annotations: { readOnly: false },
    execute: async (ctx, input) => {
      const batchId = await createBatch(
        pool, input.name, input.task_kind, input.payloads.length,
        ctx.userEntraId,
      );
      const { inserted } = await enqueueRows(
        pool, batchId,
        input.payloads.map((p) => ({
          task_kind: input.task_kind,
          payload: p,
          priority: input.priority,
        })),
      );
      log.info(
        { event: "enqueue_batch", batch_id: batchId, total: input.payloads.length, inserted },
        "batch enqueued",
      );
      await appendAudit(pool, {
        actor: ctx.userEntraId,
        action: "queue.enqueue",
        target: batchId,
        afterValue: { task_kind: input.task_kind, total: input.payloads.length, inserted },
      }).catch(() => undefined);
      return {
        batch_id: batchId,
        task_kind: input.task_kind,
        total_requested: input.payloads.length,
        inserted,
        duplicates: input.payloads.length - inserted,
      };
    },
  });
}
