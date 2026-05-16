// Integration test: manage_plan SELECT FOR UPDATE serialisation.
//
// BACKLOG.md:261 noted that `replacePlanSteps` / `insertPlanStepAt` /
// `removePlanStepAt` use `SELECT FOR UPDATE` inside `withUserContext` to
// serialise parallel mutations. Without that lock, two concurrent
// `insertPlanStepAt` calls both read the same snapshot and overwrite each
// other's edits — the second commit wins and one inserted step is silently
// lost.
//
// This test fires two `insertPlanStepAt` calls concurrently against a real
// Postgres (via the shared testcontainer), verifies the final plan contains
// ALL inserted steps (not just one), and asserts the final step count equals
// the expected value after both commits land.
//
// Skips when Docker is unavailable; CI always has Docker.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import {
  startTestPostgres,
  stopTestPostgres,
  isDockerAvailable,
} from "../helpers/postgres-container.js";
import { savePlanForSession, insertPlanStepAt } from "../../src/core/plan-store-db.js";
import type { PlanStep } from "../../src/core/plan-mode.js";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)(
  "manage_plan SELECT FOR UPDATE serialisation (integration)",
  () => {
    let pool: Pool;
    let appPool: Pool;
    // pool    — owner (chemclaw / superuser) for test-setup inserts that
    //           must bypass RLS (the session INSERT doesn't have the user's
    //           RLS context available yet).
    // appPool — chemclaw_app (NOSUPERUSER, FORCE RLS) for all plan operations
    //           so the SELECT FOR UPDATE + RLS policy path are exercised
    //           exactly as in production.
    const userId = "plan-parallel-test@example.com";

    beforeAll(async () => {
      ({ pool, appPool } = await startTestPostgres(repoRoot));
    }, 180_000);

    afterAll(async () => {
      await stopTestPostgres();
    });

    it("two concurrent insertPlanStepAt calls both land without silent overwrites", async () => {
      // Seed: a session owned by userId.
      const sessionResult = await pool.query<{ id: string }>(
        `INSERT INTO agent_sessions (user_entra_id, last_finish_reason, updated_at)
         VALUES ($1, 'stop', NOW())
         RETURNING id::text AS id`,
        [userId],
      );
      const sessionId = sessionResult.rows[0]!.id;

      // Create a plan with one initial step so the initial snapshot is non-empty.
      const initialStep: Omit<PlanStep, "step_number"> = {
        tool: "search_knowledge",
        args: { query: "initial" },
        rationale: "seed step",
      };
      const planId = await savePlanForSession(
        appPool,
        userId,
        sessionId,
        [{ step_number: 1, ...initialStep }],
        [],
      );

      // Fire two insertPlanStepAt calls concurrently at position 0.
      // With SELECT FOR UPDATE, the second call waits for the first to commit
      // before reading the plan snapshot — both edits land correctly.
      const stepA: Omit<PlanStep, "step_number"> = {
        tool: "query_kg",
        args: { predicate: "HAS_YIELD" },
        rationale: "parallel insert A",
      };
      const stepB: Omit<PlanStep, "step_number"> = {
        tool: "read_article",
        args: { slug: "compound/aspirin" },
        rationale: "parallel insert B",
      };

      const [planA, planB] = await Promise.all([
        insertPlanStepAt(appPool, userId, planId, 0, stepA),
        insertPlanStepAt(appPool, userId, planId, 0, stepB),
      ]);

      // Both calls must have returned a non-null plan.
      expect(planA).not.toBeNull();
      expect(planB).not.toBeNull();

      // The final state is whichever commit landed last. The total step count
      // must be 3 (1 initial + 2 inserted) regardless of order.
      const finalSteps = (planB ?? planA)!.steps;
      expect(finalSteps).toHaveLength(3);

      // The tools from both inserts must be present — no step was silently lost.
      const tools = finalSteps.map((s: PlanStep) => s.tool);
      expect(tools).toContain(stepA.tool);
      expect(tools).toContain(stepB.tool);
      expect(tools).toContain(initialStep.tool);
    });

    it("replacePlanSteps followed by insertPlanStepAt sees the replaced snapshot", async () => {
      // Verifies that a replace then insert sequence doesn't produce ghost steps
      // from a stale snapshot. The insert must see the replaced plan, not the
      // pre-replace plan.
      const sessionResult = await pool.query<{ id: string }>(
        `INSERT INTO agent_sessions (user_entra_id, last_finish_reason, updated_at)
         VALUES ($1, 'stop', NOW())
         RETURNING id::text AS id`,
        [userId],
      );
      const sessionId = sessionResult.rows[0]!.id;

      const planId = await savePlanForSession(
        appPool,
        userId,
        sessionId,
        [
          { step_number: 1, tool: "old_step_1", args: {}, rationale: "will be replaced" },
          { step_number: 2, tool: "old_step_2", args: {}, rationale: "will be replaced" },
        ],
        [],
      );

      // Sequentially: replace steps, then insert one more.
      const { replacePlanSteps } = await import("../../src/core/plan-store-db.js");

      await replacePlanSteps(appPool, userId, planId, [
        { step_number: 1, tool: "new_step_A", args: {}, rationale: "after replace" },
      ]);

      const afterInsert = await insertPlanStepAt(appPool, userId, planId, 1, {
        tool: "appended_step",
        args: {},
        rationale: "appended after replace",
      });

      // Must have exactly 2 steps: the one from replace + the one inserted after.
      // The two OLD steps must be gone.
      expect(afterInsert).not.toBeNull();
      const tools = afterInsert!.steps.map((s: PlanStep) => s.tool);
      expect(tools).toHaveLength(2);
      expect(tools).toContain("new_step_A");
      expect(tools).toContain("appended_step");
      expect(tools).not.toContain("old_step_1");
      expect(tools).not.toContain("old_step_2");
    });
  },
);
