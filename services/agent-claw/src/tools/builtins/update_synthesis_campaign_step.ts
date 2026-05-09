// update_synthesis_campaign_step — record a step transition (start, complete,
// fail, skip) and attach outputs / a ref_table+ref_id pointer to the leaf
// artifact (optimization_round id, chemspace_screen id, mock_eln entry id, …).

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";
import {
  JsonRecord,
  StepStatus,
  StepSummary,
  CampaignSummary,
  rowToCampaign,
  rowToStep,
  type CampaignRow,
  type StepRow,
} from "./_synthesis_shared.js";

export const UpdateSynthesisCampaignStepIn = z.object({
  campaign_id: z.string().uuid(),
  step_id: z.string().uuid(),
  status: StepStatus,
  outputs: JsonRecord.optional(),
  notes: z.string().max(2000).optional(),
  ref_table: z.string().min(1).max(100).optional(),
  ref_id: z.string().min(1).max(200).optional(),
});
export type UpdateSynthesisCampaignStepInput = z.infer<typeof UpdateSynthesisCampaignStepIn>;

export const UpdateSynthesisCampaignStepOut = z.object({
  step: StepSummary,
  campaign: CampaignSummary,
});
export type UpdateSynthesisCampaignStepOutput = z.infer<typeof UpdateSynthesisCampaignStepOut>;

export function buildUpdateSynthesisCampaignStepTool(pool: Pool) {
  return defineTool({
    id: "update_synthesis_campaign_step",
    description:
      "Transition one step's status (in_progress | completed | skipped | failed | cancelled) and attach outputs + a ref_table/ref_id pointer to the leaf artifact (e.g. an optimization_rounds row, a chemspace_screens id, a mock_eln entry uid). Updates completed_steps and bumps the campaign etag.",
    inputSchema: UpdateSynthesisCampaignStepIn,
    outputSchema: UpdateSynthesisCampaignStepOut,
    annotations: { readOnly: false },
    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) throw new Error("update_synthesis_campaign_step requires userEntraId");

      return await withUserContext(pool, userEntraId, async (client) => {
        const existing = await client.query<{ status: string }>(
          `SELECT status FROM synthesis_campaign_steps
            WHERE id = $1::uuid AND campaign_id = $2::uuid`,
          [input.step_id, input.campaign_id],
        );
        const prevStatus = existing.rows[0]?.status;
        if (!prevStatus) throw new Error("synthesis_campaign_step_not_found_or_forbidden");

        // Idempotency guard: re-completing or re-failing a terminal step is
        // a no-op for the counters but we still update outputs/notes/ref.
        const wasTerminal = prevStatus === "completed" || prevStatus === "skipped";
        const willBeTerminal = input.status === "completed" || input.status === "skipped";

        const setStartedAt = input.status === "in_progress";
        const setCompletedAt = willBeTerminal || input.status === "failed" || input.status === "cancelled";

        const updated = await client.query<StepRow>(
          `UPDATE synthesis_campaign_steps
              SET status = $3,
                  outputs = COALESCE($4::jsonb, outputs),
                  notes = COALESCE($5, notes),
                  ref_table = COALESCE($6, ref_table),
                  ref_id = COALESCE($7, ref_id),
                  started_at = CASE WHEN $8 AND started_at IS NULL THEN NOW() ELSE started_at END,
                  completed_at = CASE WHEN $9 THEN NOW() ELSE completed_at END
            WHERE id = $1::uuid AND campaign_id = $2::uuid
           RETURNING id::text, step_index, kind, status,
                     inputs, outputs, notes,
                     ref_table, ref_id,
                     ARRAY(SELECT t::text FROM unnest(depends_on) AS t) AS depends_on,
                     to_char(started_at,   'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS started_at,
                     to_char(completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS completed_at`,
          [
            input.step_id,
            input.campaign_id,
            input.status,
            input.outputs !== undefined ? JSON.stringify(input.outputs) : null,
            input.notes ?? null,
            input.ref_table ?? null,
            input.ref_id ?? null,
            setStartedAt,
            setCompletedAt,
          ],
        );
        const stepRow = updated.rows[0];
        if (!stepRow) throw new Error("synthesis_campaign_step_update_returned_no_rows");

        // Bump completed_steps only on a fresh terminal transition.
        const incrementCompleted = !wasTerminal && willBeTerminal;
        const campaignAfter = await client.query<CampaignRow>(
          `UPDATE synthesis_campaigns
              SET completed_steps = completed_steps + $2::int,
                  etag = etag + 1
            WHERE id = $1::uuid
           RETURNING id::text, nce_project_id::text, agent_session_id::text,
                     kind, name, status, goal, policy,
                     total_steps, completed_steps, outcome_summary,
                     to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS created_at,
                     to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS updated_at,
                     etag`,
          [input.campaign_id, incrementCompleted ? 1 : 0],
        );
        const campaignRow = campaignAfter.rows[0];
        if (!campaignRow) throw new Error("synthesis_campaign_not_found_after_step_update");

        const eventType: Record<typeof input.status, string> = {
          in_progress: "step_started",
          completed: "step_completed",
          skipped: "step_skipped",
          cancelled: "step_cancelled",
          failed: "step_failed",
          pending: "step_added",
        };
        await client.query(
          `INSERT INTO synthesis_campaign_events (campaign_id, step_id, event_type, payload)
           VALUES ($1::uuid, $2::uuid, $3::text,
                   jsonb_build_object('from', $4::text, 'to', $5::text,
                                      'ref_table', $6::text, 'ref_id', $7::text))`,
          [
            input.campaign_id,
            input.step_id,
            eventType[input.status],
            prevStatus,
            input.status,
            input.ref_table ?? null,
            input.ref_id ?? null,
          ],
        );

        return {
          step: rowToStep(stepRow),
          campaign: rowToCampaign(campaignRow),
        };
      });
    },
  });
}
