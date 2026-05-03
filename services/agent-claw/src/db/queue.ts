// Postgres-backed task queue — TS client used by enqueue_batch / inspect_batch.

import { createHash } from "node:crypto";
import { type Pool } from "pg";

import { withSystemContext } from "./with-user-context.js";

export interface EnqueueRow {
  task_kind: string;
  payload: Record<string, unknown>;
  priority?: number;
  max_attempts?: number;
  idempotency_key?: Buffer | null;
}

export interface BatchSummary {
  batch_id: string;
  name: string | null;
  kind: string | null;
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  created_at: string;
  finished_at: string | null;
}

export async function createBatch(
  pool: Pool,
  name: string,
  kind: string,
  total: number,
  createdBy: string,
): Promise<string> {
  return await withSystemContext(pool, async (client) => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO task_batches (name, kind, total, created_by) VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
      [name, kind, total, createdBy],
    );
    const inserted = res.rows[0];
    if (!inserted) throw new Error("task_batches INSERT returned no rows");
    return inserted.id;
  });
}

export async function enqueueRows(
  pool: Pool,
  batchId: string,
  rows: EnqueueRow[],
): Promise<{ inserted: number }> {
  if (rows.length === 0) return { inserted: 0 };
  return await withSystemContext(pool, async (client) => {
    let inserted = 0;
    for (const row of rows) {
      const idemKey =
        row.idempotency_key ??
        createHash("sha256")
          .update(row.task_kind)
          .update(JSON.stringify(canonicalize(row.payload)))
          .digest();
      const res = await client.query<{ id: string }>(
        `INSERT INTO task_queue
            (task_kind, payload, priority, batch_id, idempotency_key, max_attempts)
          VALUES ($1, $2::jsonb, COALESCE($3, 100), $4::uuid, $5, COALESCE($6, 3))
          ON CONFLICT (task_kind, idempotency_key) DO NOTHING
          RETURNING id::text AS id`,
        [
          row.task_kind,
          JSON.stringify(row.payload),
          row.priority ?? null,
          batchId,
          idemKey,
          row.max_attempts ?? null,
        ],
      );
      if (res.rowCount && res.rowCount > 0) inserted += 1;
    }
    return { inserted };
  });
}

export async function inspectBatch(
  pool: Pool,
  batchId: string,
  sampleN: number = 5,
): Promise<BatchSummary & { sample_results: Array<{ task_kind: string; status: string; result: unknown }>; }> {
  return await withSystemContext(pool, async (client) => {
    const sumRes = await client.query<BatchSummary>(
      `SELECT id::text AS batch_id, name, kind, total, succeeded, failed, cancelled,
              created_at::text AS created_at,
              finished_at::text AS finished_at
         FROM task_batches WHERE id = $1::uuid`,
      [batchId],
    );
    const summary = sumRes.rows[0];
    if (!summary) {
      throw new Error(`batch not found: ${batchId}`);
    }
    const sampleRes = await client.query<{ task_kind: string; status: string; result: unknown }>(
      `SELECT task_kind, status, result
         FROM task_queue
        WHERE batch_id = $1::uuid
        ORDER BY finished_at DESC NULLS LAST, created_at DESC
        LIMIT $2`,
      [batchId, sampleN],
    );
    return { ...summary, sample_results: sampleRes.rows };
  });
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = canonicalize(obj[k]);
      return acc;
    }, {});
}
