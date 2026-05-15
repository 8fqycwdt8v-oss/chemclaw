// advance_synthesis_campaign — purely deterministic state machine over a
// campaign's step DAG. Picks the next pending step whose depends_on are all
// completed, returns it plus a tool-hint list for the orchestrator skill.
//
// This is the load-bearing routing primitive: instead of the LLM re-deriving
// "what comes next?" every turn, the rule lives in code and the agent just
// dispatches whatever the tool returns.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";
import {
  CampaignStatus,
  StepSummary,
  STEP_KIND_TO_TOOL_HINT,
  rowToStep,
  type CampaignKindT,
  type StepRow,
  type StepKindT,
} from "./_synthesis_shared.js";

export const AdvanceSynthesisCampaignIn = z.object({
  campaign_id: z.string().uuid(),
  // If true, transition the picked step to in_progress before returning so
  // a concurrent advance call won't re-pick the same step.
  claim: z.boolean().default(true),
});
export type AdvanceSynthesisCampaignInput = z.infer<typeof AdvanceSynthesisCampaignIn>;

export const AdvanceSynthesisCampaignOut = z.object({
  decision: z.enum([
    "next_step",
    "no_ready_steps",
    "campaign_completed",
    "campaign_died",
    "campaign_terminal",
  ]),
  campaign_id: z.string().uuid(),
  campaign_status: CampaignStatus,
  step: StepSummary.nullable(),
  recommended_tools: z.array(z.string()),
  rationale: z.string(),
});
export type AdvanceSynthesisCampaignOutput = z.infer<typeof AdvanceSynthesisCampaignOut>;

interface DieCheckPolicy {
  die_after_no_improvement_rounds?: number;
  budget_max_experiments?: number;
}

interface StepInputsForDieCheck {
  rounds_run?: number;
  rounds_with_improvement?: number;
  experiments_used?: number;
}

function evaluateDieCheck(
  kind: CampaignKindT,
  policy: DieCheckPolicy,
  rolling: StepInputsForDieCheck,
): { die: boolean; reason: string } {
  if (kind !== "bo_or_die") return { die: false, reason: "kind is not bo_or_die" };
  const dieAfter = policy.die_after_no_improvement_rounds;
  const budget = policy.budget_max_experiments;
  const roundsRun = rolling.rounds_run ?? 0;
  const roundsWithImp = rolling.rounds_with_improvement ?? 0;
  const expsUsed = rolling.experiments_used ?? 0;

  if (typeof dieAfter === "number" && dieAfter > 0 && roundsRun - roundsWithImp >= dieAfter) {
    return {
      die: true,
      reason: `bo_or_die: ${roundsRun - roundsWithImp} consecutive rounds without improvement (cap=${dieAfter}).`,
    };
  }
  if (typeof budget === "number" && budget > 0 && expsUsed >= budget) {
    return {
      die: true,
      reason: `bo_or_die: experiment budget exhausted (${expsUsed}/${budget}).`,
    };
  }
  return { die: false, reason: "bo_or_die guards not tripped." };
}

export function buildAdvanceSynthesisCampaignTool(pool: Pool) {
  return defineTool({
    id: "advance_synthesis_campaign",
    description:
      "Pick the next pending step of a synthesis campaign whose dependencies are satisfied, claim it (status → in_progress) by default, and return tool-hints for the orchestrator. Also flips the campaign to 'completed' or 'died' on its own when all steps finish or a bo_or_die policy gate trips. Returns one of: next_step | no_ready_steps | campaign_completed | campaign_died | campaign_terminal.",
    inputSchema: AdvanceSynthesisCampaignIn,
    outputSchema: AdvanceSynthesisCampaignOut,
    annotations: { readOnly: false },
    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) throw new Error("advance_synthesis_campaign requires userEntraId");

      return await withUserContext(pool, userEntraId, async (client) => {
        const camp = await client.query<{
          id: string;
          kind: CampaignKindT;
          status: string;
          policy: unknown;
          total_steps: number;
          completed_steps: number;
        }>(
          `SELECT id::text, kind, status, policy, total_steps, completed_steps
             FROM synthesis_campaigns WHERE id = $1::uuid FOR UPDATE`,
          [input.campaign_id],
        );
        const campaign = camp.rows[0];
        if (!campaign) throw new Error("synthesis_campaign_not_found_or_forbidden");

        // Already-terminal campaigns return without doing anything.
        if (
          campaign.status === "completed" ||
          campaign.status === "aborted" ||
          campaign.status === "failed" ||
          campaign.status === "died"
        ) {
          return {
            decision: "campaign_terminal" as const,
            campaign_id: campaign.id,
            campaign_status: campaign.status as z.infer<typeof CampaignStatus>,
            step: null,
            recommended_tools: [],
            rationale: `Campaign already ${campaign.status}; no further action.`,
          };
        }

        // BO-or-die gate evaluation: aggregate from prior bo_round outputs.
        if (campaign.kind === "bo_or_die") {
          const rolling = await client.query<{
            rounds_run: number;
            rounds_with_improvement: number;
            experiments_used: number;
          }>(
            `SELECT
               COUNT(*) FILTER (WHERE kind='bo_round' AND status='completed')::int                    AS rounds_run,
               COALESCE(SUM(CASE WHEN kind='bo_round' AND status='completed'
                                    AND COALESCE((outputs->>'improved')::boolean, FALSE)
                                  THEN 1 ELSE 0 END), 0)::int                                          AS rounds_with_improvement,
               COALESCE(SUM(CASE WHEN kind='ingest_results' AND status='completed'
                                  THEN COALESCE((outputs->>'experiments_added')::int, 0)
                                  ELSE 0 END), 0)::int                                                AS experiments_used
             FROM synthesis_campaign_steps WHERE campaign_id = $1::uuid`,
            [campaign.id],
          );
          const r = rolling.rows[0] ?? { rounds_run: 0, rounds_with_improvement: 0, experiments_used: 0 };
          const verdict = evaluateDieCheck(
            campaign.kind,
            (campaign.policy ?? {}),
            r,
          );
          if (verdict.die) {
            await client.query(
              `UPDATE synthesis_campaigns SET status = 'died', etag = etag + 1 WHERE id = $1::uuid`,
              [campaign.id],
            );
            await client.query(
              `INSERT INTO synthesis_campaign_events (campaign_id, event_type, payload)
               VALUES ($1::uuid, 'die_triggered',
                       jsonb_build_object('reason', $2::text,
                                          'rounds_run', $3::int,
                                          'rounds_with_improvement', $4::int,
                                          'experiments_used', $5::int))`,
              [campaign.id, verdict.reason, r.rounds_run, r.rounds_with_improvement, r.experiments_used],
            );
            return {
              decision: "campaign_died" as const,
              campaign_id: campaign.id,
              campaign_status: "died" as const,
              step: null,
              recommended_tools: [],
              rationale: verdict.reason,
            };
          }
        }

        // Find the lowest-step_index pending step whose depends_on are all completed.
        const ready = await client.query<StepRow>(
          `SELECT s.id::text, s.step_index, s.kind, s.status,
                  s.inputs, s.outputs, s.notes,
                  s.ref_table, s.ref_id,
                  ARRAY(SELECT t::text FROM unnest(s.depends_on) AS t) AS depends_on,
                  to_char(s.started_at,   'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS started_at,
                  to_char(s.completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS completed_at
             FROM synthesis_campaign_steps s
            WHERE s.campaign_id = $1::uuid
              AND s.status = 'pending'
              AND NOT EXISTS (
                SELECT 1 FROM unnest(s.depends_on) AS dep_id
                  JOIN synthesis_campaign_steps d ON d.id = dep_id
                 WHERE d.status NOT IN ('completed', 'skipped')
              )
            ORDER BY s.step_index ASC
            LIMIT 1`,
          [campaign.id],
        );
        const stepRow = ready.rows[0];

        if (!stepRow) {
          // No ready steps. If every step is terminal → campaign_completed.
          const remaining = await client.query<{ pending: number; in_progress: number }>(
            `SELECT
               COUNT(*) FILTER (WHERE status = 'pending')::int     AS pending,
               COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress
             FROM synthesis_campaign_steps WHERE campaign_id = $1::uuid`,
            [campaign.id],
          );
          const r = remaining.rows[0] ?? { pending: 0, in_progress: 0 };
          if (r.pending === 0 && r.in_progress === 0) {
            await client.query(
              `UPDATE synthesis_campaigns
                  SET status = 'completed', etag = etag + 1
                WHERE id = $1::uuid`,
              [campaign.id],
            );
            await client.query(
              `INSERT INTO synthesis_campaign_events (campaign_id, event_type, payload)
               VALUES ($1::uuid, 'campaign_completed', '{}'::jsonb)`,
              [campaign.id],
            );
            return {
              decision: "campaign_completed" as const,
              campaign_id: campaign.id,
              campaign_status: "completed" as const,
              step: null,
              recommended_tools: [],
              rationale: "All steps reached terminal status.",
            };
          }
          return {
            decision: "no_ready_steps" as const,
            campaign_id: campaign.id,
            campaign_status: campaign.status as z.infer<typeof CampaignStatus>,
            step: null,
            recommended_tools: [],
            rationale: `${r.in_progress} step(s) in_progress, ${r.pending} pending with unmet dependencies.`,
          };
        }

        // Optionally claim it (in_progress + started_at), then flip the campaign to 'active'
        // if it was still 'proposed'.
        if (input.claim) {
          const claimResult = await client.query(
            `UPDATE synthesis_campaign_steps
                SET status = 'in_progress',
                    started_at = COALESCE(started_at, NOW())
              WHERE id = $1::uuid AND status = 'pending'`,
            [stepRow.id],
          );
          stepRow.status = "in_progress";
          stepRow.started_at ??= new Date().toISOString();
          // Bump campaign etag so a snapshot consumer sees the step claim,
          // restoring symmetry with the other state-mutating branches (die,
          // completed, proposed→active) that already bump etag. Two guards:
          //   - rowCount > 0: skip on a no-op claim (step already in_progress
          //     under a race) so etag doesn't churn.
          //   - status !== "proposed": skip when the downstream proposed→active
          //     UPDATE will bump etag anyway, avoiding a double-bump on the
          //     default fresh-campaign first-step path (claim defaults to true;
          //     new campaigns start as 'proposed').
          if ((claimResult.rowCount ?? 0) > 0 && campaign.status !== "proposed") {
            await client.query(
              `UPDATE synthesis_campaigns SET etag = etag + 1 WHERE id = $1::uuid`,
              [campaign.id],
            );
          }
        }
        if (campaign.status === "proposed") {
          await client.query(
            `UPDATE synthesis_campaigns
                SET status = 'active', etag = etag + 1
              WHERE id = $1::uuid AND status = 'proposed'`,
            [campaign.id],
          );
        }

        const stepKind: StepKindT = stepRow.kind;
        const tools = STEP_KIND_TO_TOOL_HINT[stepKind];
        return {
          decision: "next_step" as const,
          campaign_id: campaign.id,
          campaign_status: (campaign.status === "proposed" ? "active" : campaign.status) as z.infer<typeof CampaignStatus>,
          step: rowToStep(stepRow),
          recommended_tools: tools,
          rationale: `Next ready step is index ${stepRow.step_index} (kind=${stepKind}). Recommended tools: ${tools.join(", ") || "(none — rely on skill prompt)"}.`,
        };
      });
    },
  });
}
