// record_synthesis_campaign_outcome — terminal write that closes a campaign:
//   * sets status (completed | aborted | failed | died)
//   * persists outcome_summary
//   * emits a measurement_recorded event when measurements are attached
//
// Distinct from update_synthesis_campaign_step: this operates on the campaign,
// not on one step, and is what the orchestrator calls at the very end of the
// 'summary' step or when policy demands an early abort.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";
import {
  CampaignSummary,
  JsonRecord,
  rowToCampaign,
  type CampaignRow,
} from "./_synthesis_shared.js";

export const RecordSynthesisCampaignOutcomeIn = z.object({
  campaign_id: z.string().uuid(),
  status: z.enum(["completed", "aborted", "failed", "died", "paused"]),
  outcome_summary: z.string().min(1).max(8000),
  // Optional structured measurement payload (e.g. final yield, Pareto front).
  measurements: JsonRecord.optional(),
});
export type RecordSynthesisCampaignOutcomeInput = z.infer<
  typeof RecordSynthesisCampaignOutcomeIn
>;

export const RecordSynthesisCampaignOutcomeOut = z.object({
  campaign: CampaignSummary,
});
export type RecordSynthesisCampaignOutcomeOutput = z.infer<
  typeof RecordSynthesisCampaignOutcomeOut
>;

export function buildRecordSynthesisCampaignOutcomeTool(pool: Pool) {
  return defineTool({
    id: "record_synthesis_campaign_outcome",
    description:
      "Close a synthesis campaign with a terminal status (completed | aborted | failed | died | paused) and a human-readable outcome summary. Optionally attach a structured measurements payload (final yields, Pareto front, readiness verdict). Bumps the campaign etag and writes a campaign_completed/aborted event.",
    inputSchema: RecordSynthesisCampaignOutcomeIn,
    outputSchema: RecordSynthesisCampaignOutcomeOut,
    annotations: { readOnly: false },
    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId)
        throw new Error("record_synthesis_campaign_outcome requires userEntraId");

      return await withUserContext(pool, userEntraId, async (client) => {
        const updated = await client.query<CampaignRow>(
          `UPDATE synthesis_campaigns
              SET status = $2,
                  outcome_summary = $3,
                  etag = etag + 1
            WHERE id = $1::uuid
           RETURNING id::text, nce_project_id::text, agent_session_id::text,
                     kind, name, status, goal, policy,
                     total_steps, completed_steps, outcome_summary,
                     to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS created_at,
                     to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS updated_at,
                     etag`,
          [input.campaign_id, input.status, input.outcome_summary],
        );
        const campaignRow = updated.rows[0];
        if (!campaignRow) throw new Error("synthesis_campaign_not_found_or_forbidden");

        const eventType =
          input.status === "completed"
            ? "campaign_completed"
            : input.status === "aborted" || input.status === "failed" || input.status === "died"
              ? "campaign_aborted"
              : "campaign_status_changed";

        await client.query(
          `INSERT INTO synthesis_campaign_events (campaign_id, event_type, payload)
           VALUES ($1::uuid, $2::text,
                   jsonb_build_object('status', $3::text,
                                      'outcome_summary', $4::text,
                                      'measurements', $5::jsonb))`,
          [
            input.campaign_id,
            eventType,
            input.status,
            input.outcome_summary,
            input.measurements ? JSON.stringify(input.measurements) : "{}",
          ],
        );

        if (input.measurements) {
          await client.query(
            `INSERT INTO synthesis_campaign_events (campaign_id, event_type, payload)
             VALUES ($1::uuid, 'measurement_recorded', $2::jsonb)`,
            [input.campaign_id, JSON.stringify(input.measurements)],
          );
        }

        return { campaign: rowToCampaign(campaignRow) };
      });
    },
  });
}
