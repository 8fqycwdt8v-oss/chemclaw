// Workflow DB client — used by the six workflow_* agent builtins and the
// (future) Python workflow executor. Keeps the SQL shape in one place so
// schema changes don't ripple through every builtin.

import { type Pool } from "pg";

import { withSystemContext } from "../../db/with-user-context.js";
import type { WorkflowDefinition } from "./types.js";
import { validateWorkflowDefinition as validate } from "./validator.js";

export interface WorkflowRecord {
  id: string;
  name: string;
  version: number;
  definition: WorkflowDefinition;
  created_by: string;
  created_at: string;
}

export interface WorkflowRunRecord {
  id: string;
  workflow_id: string;
  parent_run_id: string | null;
  session_id: string | null;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  started_at: string | null;
  finished_at: string | null;
  paused_at: string | null;
  created_by: string;
  created_at: string;
}

export interface WorkflowEventRecord {
  id: number;
  run_id: string;
  seq: number;
  kind: string;
  step_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export async function defineWorkflow(
  pool: Pool,
  rawDefinition: unknown,
  createdBy: string,
): Promise<WorkflowRecord> {
  const def = validate(rawDefinition);
  return await withSystemContext(pool, async (client) => {
    // Bump version: pick next int per name; close any prior live row.
    const next = await client.query<{ next_version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM workflows WHERE name = $1`,
      [def.name],
    );
    const versionRow = next.rows[0];
    if (!versionRow) throw new Error("workflow version SELECT returned no rows");
    const version = versionRow.next_version;
    await client.query(
      `UPDATE workflows SET valid_to = NOW() WHERE name = $1 AND valid_to IS NULL`,
      [def.name],
    );
    const res = await client.query<WorkflowRecord>(
      `INSERT INTO workflows (name, version, definition, created_by)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id::text AS id, name, version, definition,
                 created_by, created_at::text AS created_at`,
      [def.name, version, JSON.stringify(def), createdBy],
    );
    const inserted = res.rows[0];
    if (!inserted) throw new Error("workflows INSERT returned no rows");
    return inserted;
  });
}

export async function startRun(
  pool: Pool,
  workflowId: string,
  input: Record<string, unknown>,
  createdBy: string,
  sessionId: string | null = null,
): Promise<string> {
  return await withSystemContext(pool, async (client) => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO workflow_runs (workflow_id, session_id, status, input, started_at, created_by)
       VALUES ($1::uuid, $2::uuid, 'running', $3::jsonb, NOW(), $4)
       RETURNING id::text AS id`,
      [workflowId, sessionId, JSON.stringify(input), createdBy],
    );
    const startRow = res.rows[0];
    if (!startRow) throw new Error("workflow_runs INSERT returned no rows");
    const runId = startRow.id;
    await appendEvent(client, runId, "start", null, { input });
    await client.query(
      `INSERT INTO workflow_state (run_id, current_step, scope, cursor)
       VALUES ($1::uuid, NULL, '{}'::jsonb, '{}'::jsonb)
       ON CONFLICT (run_id) DO NOTHING`,
      [runId],
    );
    return runId;
  });
}

export async function inspectRun(
  pool: Pool,
  runId: string,
  eventLimit: number = 50,
): Promise<{ run: WorkflowRunRecord; state: { current_step: string | null; scope: unknown; cursor: unknown } | null; events: WorkflowEventRecord[] }> {
  return await withSystemContext(pool, async (client) => {
    const runRes = await client.query<WorkflowRunRecord>(
      `SELECT id::text AS id, workflow_id::text AS workflow_id,
              parent_run_id::text AS parent_run_id, session_id::text AS session_id,
              status, input, output,
              started_at::text AS started_at, finished_at::text AS finished_at,
              paused_at::text AS paused_at,
              created_by, created_at::text AS created_at
         FROM workflow_runs WHERE id = $1::uuid`,
      [runId],
    );
    const run = runRes.rows[0];
    if (!run) throw new Error(`workflow run not found: ${runId}`);

    const stateRes = await client.query<{ current_step: string | null; scope: unknown; cursor: unknown }>(
      `SELECT current_step, scope, cursor FROM workflow_state WHERE run_id = $1::uuid`,
      [runId],
    );
    const eventsRes = await client.query<WorkflowEventRecord>(
      `SELECT id, run_id::text AS run_id, seq, kind, step_id, payload,
              created_at::text AS created_at
         FROM workflow_events
        WHERE run_id = $1::uuid
        ORDER BY seq DESC
        LIMIT $2`,
      [runId, eventLimit],
    );
    return {
      run,
      state: stateRes.rows[0] ?? null,
      events: eventsRes.rows.reverse(),
    };
  });
}

export async function pauseRun(pool: Pool, runId: string, by: string): Promise<void> {
  await withSystemContext(pool, async (client) => {
    await client.query(
      `UPDATE workflow_runs SET status = 'paused', paused_at = NOW()
        WHERE id = $1::uuid AND status = 'running'`,
      [runId],
    );
    await appendEvent(client, runId, "pause", null, { by });
  });
}

export async function resumeRun(pool: Pool, runId: string, by: string): Promise<void> {
  await withSystemContext(pool, async (client) => {
    await client.query(
      `UPDATE workflow_runs SET status = 'running', paused_at = NULL
        WHERE id = $1::uuid AND status = 'paused'`,
      [runId],
    );
    await appendEvent(client, runId, "resume", null, { by });
  });
}

export async function modifyDefinition(
  pool: Pool,
  runId: string,
  newDefinition: unknown,
  by: string,
  justification: string,
): Promise<void> {
  const def = validate(newDefinition);
  await withSystemContext(pool, async (client) => {
    const wf = await client.query<{ workflow_id: string; status: string; old: WorkflowDefinition }>(
      `SELECT r.workflow_id::text AS workflow_id, r.status, w.definition AS old
         FROM workflow_runs r
         JOIN workflows w ON w.id = r.workflow_id
        WHERE r.id = $1::uuid`,
      [runId],
    );
    const row = wf.rows[0];
    if (!row) throw new Error(`run not found: ${runId}`);
    if (row.status !== "paused") {
      throw new Error("run must be paused before workflow_modify");
    }
    await client.query(
      `INSERT INTO workflow_modifications
         (run_id, before_definition, after_definition, applied_by, justification)
       VALUES ($1::uuid, $2::jsonb, $3::jsonb, $4, $5)`,
      [runId, JSON.stringify(row.old), JSON.stringify(def), by, justification],
    );
    await appendEvent(client, runId, "modify", null, {
      by, justification, after: def,
    });
  });
}

export async function replayRun(
  pool: Pool,
  parentRunId: string,
  inputOverride: Record<string, unknown> | null,
  by: string,
): Promise<string> {
  return await withSystemContext(pool, async (client) => {
    const r = await client.query<{ workflow_id: string; input: Record<string, unknown> }>(
      `SELECT workflow_id::text AS workflow_id, input FROM workflow_runs WHERE id = $1::uuid`,
      [parentRunId],
    );
    const parent = r.rows[0];
    if (!parent) throw new Error(`parent run not found: ${parentRunId}`);
    const input = inputOverride ?? parent.input;
    const ins = await client.query<{ id: string }>(
      `INSERT INTO workflow_runs (workflow_id, parent_run_id, status, input, started_at, created_by)
       VALUES ($1::uuid, $2::uuid, 'running', $3::jsonb, NOW(), $4)
       RETURNING id::text AS id`,
      [parent.workflow_id, parentRunId, JSON.stringify(input), by],
    );
    const insertedRow = ins.rows[0];
    if (!insertedRow) throw new Error("replay workflow_runs INSERT returned no rows");
    const runId = insertedRow.id;
    await appendEvent(client, runId, "replay", null, { parent_run_id: parentRunId, by });
    return runId;
  });
}

async function appendEvent(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  runId: string,
  kind: string,
  stepId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO workflow_events (run_id, seq, kind, step_id, payload)
     SELECT $1::uuid,
            COALESCE((SELECT MAX(seq) FROM workflow_events WHERE run_id = $1::uuid), 0) + 1,
            $2, $3, $4::jsonb`,
    [runId, kind, stepId, JSON.stringify(payload)],
  );
}
