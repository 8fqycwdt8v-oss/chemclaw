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
  initial_messages: Message[];
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
