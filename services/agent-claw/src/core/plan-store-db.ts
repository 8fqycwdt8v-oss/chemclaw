// DB-backed plan storage for Phase E (Plan v2 — chained execution).
//
// Replaces the in-memory 5-minute planStore for the new chained-execution
// path. Plans are tied to an agent_sessions row (RLS via the session) and
// persist for the session's lifetime, so a multi-turn plan that exceeds
// AGENT_CHAT_MAX_STEPS can pick up where it left off on the next turn.
//
// The old in-memory planStore in core/plan-mode.ts stays for backward
// compatibility with tests + the /api/chat/plan/approve single-shot path.

import type { Pool } from "pg";
import { withUserContext } from "../db/with-user-context.js";
import type { PlanStep } from "./plan-mode.js";
import type { Message } from "./types.js";

export type PlanStatus =
  | "proposed"
  | "approved"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export interface DbPlan {
  id: string;
  sessionId: string;
  steps: PlanStep[];
  currentStepIndex: number;
  status: PlanStatus;
  initialMessages: Message[];
  createdAt: Date;
  updatedAt: Date;
}

interface PlanRow {
  id: string;
  session_id: string;
  steps: PlanStep[];
  current_step_index: number;
  status: PlanStatus;
  initial_messages: Message[] | null;
  created_at: Date;
  updated_at: Date;
}

function rowToPlan(row: PlanRow): DbPlan {
  return {
    id: row.id,
    sessionId: row.session_id,
    steps: row.steps,
    currentStepIndex: row.current_step_index,
    status: row.status,
    initialMessages: row.initial_messages ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Persist a fresh plan (status='proposed') tied to a session. Returns the
 * new plan row id. Callers (the /plan slash verb) emit this id back to
 * the client in the plan_ready event so the client can later POST
 * /api/sessions/:id/plan/run to start chained execution.
 */
export async function savePlanForSession(
  pool: Pool,
  userEntraId: string,
  sessionId: string,
  steps: PlanStep[],
  initialMessages: Message[],
): Promise<string> {
  return await withUserContext(pool, userEntraId, async (client) => {
    const r = await client.query<{ id: string }>(
      `INSERT INTO agent_plans (session_id, steps, initial_messages, status)
       VALUES ($1::uuid, $2::jsonb, $3::jsonb, 'proposed')
       RETURNING id::text AS id`,
      [sessionId, JSON.stringify(steps), JSON.stringify(initialMessages)],
    );
    const id = r.rows[0]?.id;
    if (!id) throw new Error("savePlanForSession: INSERT returned no row");
    return id;
  });
}

/**
 * Look up the most-recent active plan for a session. "Active" means
 * status ∈ {approved, running, proposed} — completed/cancelled/failed are
 * excluded so the resume endpoint doesn't accidentally re-run a finished plan.
 */
export async function loadActivePlanForSession(
  pool: Pool,
  userEntraId: string,
  sessionId: string,
): Promise<DbPlan | null> {
  return await withUserContext(pool, userEntraId, async (client) => {
    const r = await client.query<PlanRow>(
      `SELECT id::text AS id,
              session_id::text AS session_id,
              steps,
              current_step_index,
              status,
              initial_messages,
              created_at,
              updated_at
         FROM agent_plans
        WHERE session_id = $1::uuid
          AND status IN ('proposed', 'approved', 'running')
        ORDER BY created_at DESC
        LIMIT 1`,
      [sessionId],
    );
    const row = r.rows[0];
    return row ? rowToPlan(row) : null;
  });
}

/**
 * Update a plan's progress. Used after each chained-execution turn.
 * Pass status='running' to mark in-flight, 'completed' when done.
 */
export async function advancePlan(
  pool: Pool,
  userEntraId: string,
  planId: string,
  patch: { currentStepIndex?: number; status?: PlanStatus },
): Promise<void> {
  await withUserContext(pool, userEntraId, async (client) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.currentStepIndex !== undefined) {
      sets.push(`current_step_index = $${params.length + 1}`);
      params.push(patch.currentStepIndex);
    }
    if (patch.status !== undefined) {
      sets.push(`status = $${params.length + 1}`);
      params.push(patch.status);
    }
    if (sets.length === 0) return;
    params.push(planId);
    await client.query(
      `UPDATE agent_plans SET ${sets.join(", ")} WHERE id = $${params.length}::uuid`,
      params,
    );
  });
}

// ---------------------------------------------------------------------------
// Mutable-plan operations (Phase A3 — adaptive replanning).
//
// The original advancePlan only mutated current_step_index + status. Plans
// were write-once after approval: if step 3 turned out to be impossible, the
// agent had no in-loop way to amend the plan and had to break out via
// ask_user. These helpers let the agent decompose a stuck step, insert a
// remedial step, or replace a wrong step in flight.
//
// All three preserve the invariant that current_step_index points at the
// next un-executed step. When a mutation moves steps before the cursor,
// the cursor doesn't shift; mutations at or after the cursor are positional.
// Re-renumbers `step_number` so the linear plan walker in chained-harness
// still works.
// ---------------------------------------------------------------------------

export async function replacePlanSteps(
  pool: Pool,
  userEntraId: string,
  planId: string,
  steps: PlanStep[],
): Promise<DbPlan | null> {
  return await withUserContext(pool, userEntraId, async (client) => {
    const renumbered = _renumber(steps);
    const r = await client.query<PlanRow>(
      `UPDATE agent_plans
          SET steps = $2::jsonb
        WHERE id = $1::uuid
        RETURNING id::text AS id,
                  session_id::text AS session_id,
                  steps,
                  current_step_index,
                  status,
                  initial_messages,
                  created_at,
                  updated_at`,
      [planId, JSON.stringify(renumbered)],
    );
    const row = r.rows[0];
    return row ? rowToPlan(row) : null;
  });
}

export async function insertPlanStepAt(
  pool: Pool,
  userEntraId: string,
  planId: string,
  insertAt: number,
  step: Omit<PlanStep, "step_number">,
): Promise<DbPlan | null> {
  return await withUserContext(pool, userEntraId, async (client) => {
    // SELECT FOR UPDATE inside the withUserContext transaction so two
    // parallel insert/remove calls on the same plan_id serialise instead
    // of read-modify-writing on stale snapshots. Without this, parallel
    // manage_plan calls (chat tab + reanimator both resuming the same
    // session) silently overwrite each other's edits — the second commit
    // wins and the first's mutation is lost.
    const r0 = await client.query<PlanRow>(
      `SELECT id::text AS id,
              session_id::text AS session_id,
              steps,
              current_step_index,
              status,
              initial_messages,
              created_at,
              updated_at
         FROM agent_plans
        WHERE id = $1::uuid
        FOR UPDATE`,
      [planId],
    );
    const row0 = r0.rows[0];
    if (!row0) return null;
    const before = row0.steps;
    const idx = Math.max(0, Math.min(insertAt, before.length));
    const next = [
      ...before.slice(0, idx),
      { step_number: 0, ...step },
      ...before.slice(idx),
    ];
    const renumbered = _renumber(next);
    const r1 = await client.query<PlanRow>(
      `UPDATE agent_plans
          SET steps = $2::jsonb
        WHERE id = $1::uuid
        RETURNING id::text AS id,
                  session_id::text AS session_id,
                  steps,
                  current_step_index,
                  status,
                  initial_messages,
                  created_at,
                  updated_at`,
      [planId, JSON.stringify(renumbered)],
    );
    const row1 = r1.rows[0];
    return row1 ? rowToPlan(row1) : null;
  });
}

export async function removePlanStepAt(
  pool: Pool,
  userEntraId: string,
  planId: string,
  removeAt: number,
): Promise<DbPlan | null> {
  return await withUserContext(pool, userEntraId, async (client) => {
    // SELECT FOR UPDATE inside the withUserContext transaction so two
    // parallel insert/remove calls on the same plan_id serialise instead
    // of read-modify-writing on stale snapshots. Without this, parallel
    // manage_plan calls (chat tab + reanimator both resuming the same
    // session) silently overwrite each other's edits — the second commit
    // wins and the first's mutation is lost.
    const r0 = await client.query<PlanRow>(
      `SELECT id::text AS id,
              session_id::text AS session_id,
              steps,
              current_step_index,
              status,
              initial_messages,
              created_at,
              updated_at
         FROM agent_plans
        WHERE id = $1::uuid
        FOR UPDATE`,
      [planId],
    );
    const row0 = r0.rows[0];
    if (!row0) return null;
    const before = row0.steps;
    if (removeAt < 0 || removeAt >= before.length) {
      // Out-of-range removal is a no-op; return the unchanged plan so the
      // caller can decide whether to surface a warning.
      return rowToPlan(row0);
    }
    const next = [...before.slice(0, removeAt), ...before.slice(removeAt + 1)];
    const renumbered = _renumber(next);
    // If we removed a step before the cursor, shift the cursor left so it
    // still points at the same logical "next un-executed" step.
    const newIndex =
      removeAt < row0.current_step_index
        ? Math.max(0, row0.current_step_index - 1)
        : row0.current_step_index;
    const r1 = await client.query<PlanRow>(
      `UPDATE agent_plans
          SET steps = $2::jsonb,
              current_step_index = $3
        WHERE id = $1::uuid
        RETURNING id::text AS id,
                  session_id::text AS session_id,
                  steps,
                  current_step_index,
                  status,
                  initial_messages,
                  created_at,
                  updated_at`,
      [planId, JSON.stringify(renumbered), newIndex],
    );
    const row1 = r1.rows[0];
    return row1 ? rowToPlan(row1) : null;
  });
}

function _renumber(steps: PlanStep[]): PlanStep[] {
  return steps.map((s, i) => ({ ...s, step_number: i + 1 }));
}
