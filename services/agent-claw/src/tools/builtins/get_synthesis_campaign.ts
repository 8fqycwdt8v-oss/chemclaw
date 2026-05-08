// get_synthesis_campaign — fetch one campaign + its steps + recent events.
// Used by the orchestrator skill to (a) hydrate a resumed campaign on a fresh
// session, and (b) inspect step status before deciding the next move.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";
import {
  CampaignSummary,
  StepSummary,
  rowToCampaign,
  rowToStep,
  type CampaignRow,
  type StepRow,
} from "./_synthesis_shared.js";

export const GetSynthesisCampaignIn = z.object({
  campaign_id: z.string().uuid(),
  include_events: z.boolean().default(true),
  events_limit: z.number().int().min(1).max(200).default(50),
});
export type GetSynthesisCampaignInput = z.infer<typeof GetSynthesisCampaignIn>;

const EventSummary = z.object({
  id: z.string().uuid(),
  step_id: z.string().uuid().nullable(),
  event_type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  occurred_at: z.string(),
});

export const GetSynthesisCampaignOut = z.object({
  campaign: CampaignSummary,
  steps: z.array(StepSummary),
  events: z.array(EventSummary),
});
export type GetSynthesisCampaignOutput = z.infer<typeof GetSynthesisCampaignOut>;

interface EventRow {
  id: string;
  step_id: string | null;
  event_type: string;
  payload: unknown;
  occurred_at: string;
}

export function buildGetSynthesisCampaignTool(pool: Pool) {
  return defineTool({
    id: "get_synthesis_campaign",
    description:
      "Fetch one synthesis campaign by id, including its full step DAG and recent events. Use to resume a campaign on a new session or to inspect step status before deciding the next action.",
    inputSchema: GetSynthesisCampaignIn,
    outputSchema: GetSynthesisCampaignOut,
    annotations: { readOnly: true },
    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) throw new Error("get_synthesis_campaign requires userEntraId");

      return await withUserContext(pool, userEntraId, async (client) => {
        const campaign = await client.query<CampaignRow>(
          `SELECT id::text, nce_project_id::text, agent_session_id::text,
                  kind, name, status, goal, policy,
                  total_steps, completed_steps, outcome_summary,
                  to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS created_at,
                  to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS updated_at,
                  etag
             FROM synthesis_campaigns WHERE id = $1::uuid`,
          [input.campaign_id],
        );
        const campaignRow = campaign.rows[0];
        if (!campaignRow) throw new Error("synthesis_campaign_not_found_or_forbidden");

        const steps = await client.query<StepRow>(
          `SELECT id::text, step_index, kind, status,
                  inputs, outputs, notes,
                  ref_table, ref_id,
                  ARRAY(SELECT t::text FROM unnest(depends_on) AS t) AS depends_on,
                  to_char(started_at,   'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS started_at,
                  to_char(completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS completed_at
             FROM synthesis_campaign_steps
            WHERE campaign_id = $1::uuid
            ORDER BY step_index ASC`,
          [input.campaign_id],
        );

        let events: EventRow[] = [];
        if (input.include_events) {
          const ev = await client.query<EventRow>(
            `SELECT id::text, step_id::text, event_type, payload,
                    to_char(occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS occurred_at
               FROM synthesis_campaign_events
              WHERE campaign_id = $1::uuid
              ORDER BY occurred_at DESC
              LIMIT $2`,
            [input.campaign_id, input.events_limit],
          );
          events = ev.rows;
        }

        return {
          campaign: rowToCampaign(campaignRow),
          steps: steps.rows.map(rowToStep),
          events: events.map((e) => ({
            id: e.id,
            step_id: e.step_id,
            event_type: e.event_type,
            payload: (e.payload ?? {}) as Record<string, unknown>,
            occurred_at: e.occurred_at,
          })),
        };
      });
    },
  });
}
