// start_synthesis_campaign — create the umbrella row for an autonomous
// synthesis-planning workflow and queue the per-kind playbook of steps.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";
import {
  CampaignKind,
  CampaignSummary,
  JsonRecord,
  PLAYBOOK,
  rowToCampaign,
  type CampaignRow,
  type CampaignKindT,
} from "./_synthesis_shared.js";

export const StartSynthesisCampaignIn = z.object({
  nce_project_internal_id: z.string().min(1).max(200),
  kind: CampaignKind,
  name: z.string().min(1).max(200),
  goal: JsonRecord.default({}),
  policy: JsonRecord.default({}),
  // If true, the per-kind playbook step list is appended as `pending` steps.
  // If false, the agent will hand-pick steps via add_synthesis_campaign_step.
  seed_playbook: z.boolean().default(true),
});
export type StartSynthesisCampaignInput = z.infer<typeof StartSynthesisCampaignIn>;

export const StartSynthesisCampaignOut = z.object({
  campaign: CampaignSummary,
  seeded_step_kinds: z.array(z.string()),
});
export type StartSynthesisCampaignOutput = z.infer<typeof StartSynthesisCampaignOut>;

export function buildStartSynthesisCampaignTool(pool: Pool) {
  return defineTool({
    id: "start_synthesis_campaign",
    description:
      "Create a synthesis_campaigns umbrella row (kind ∈ single_experiment | library_synthesis | screening | bo_campaign | bo_or_die) and optionally seed the per-kind playbook of pending steps. Use when the user asks to plan a synthesis, a library, a screening campaign, or a BO/BO-or-die optimisation. Returns the campaign + seeded step kinds.",
    inputSchema: StartSynthesisCampaignIn,
    outputSchema: StartSynthesisCampaignOut,
    annotations: { readOnly: false },
    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) throw new Error("start_synthesis_campaign requires userEntraId");

      const sessionId = (ctx.scratchpad.get("session_id") as string | undefined) ?? null;
      const kind: CampaignKindT = input.kind;
      const playbookSteps = input.seed_playbook ? PLAYBOOK[kind] : [];

      return await withUserContext(pool, userEntraId, async (client) => {
        const proj = await client.query<{ id: string }>(
          `SELECT id::text FROM nce_projects WHERE internal_id = $1`,
          [input.nce_project_internal_id],
        );
        const nceProjectId = proj.rows[0]?.id;
        if (!nceProjectId) throw new Error("nce_project_not_found_or_forbidden");

        const inserted = await client.query<CampaignRow>(
          `INSERT INTO synthesis_campaigns
             (nce_project_id, agent_session_id, kind, name, goal, policy,
              status, created_by_user_entra_id)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'proposed', $7)
           RETURNING id::text, nce_project_id::text, agent_session_id::text,
                     kind, name, status, goal, policy,
                     total_steps, completed_steps, outcome_summary,
                     to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS created_at,
                     to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS updated_at,
                     etag`,
          [
            nceProjectId,
            sessionId,
            input.kind,
            input.name,
            JSON.stringify(input.goal),
            JSON.stringify(input.policy),
            userEntraId,
          ],
        );
        const campaignRow = inserted.rows[0];
        if (!campaignRow) throw new Error("synthesis_campaign_insert_returned_no_rows");

        // Seed the per-kind playbook as pending steps, if requested. Each
        // step depends on the previous one — the playbooks are linear
        // chains today, but the resolver in advance_synthesis_campaign is
        // depends_on-aware, so wiring real prerequisites means a stalled
        // step blocks downstream picks instead of the resolver silently
        // walking past it on step_index alone.
        if (playbookSteps.length > 0) {
          const insertedIds: string[] = [];
          for (const [i, stepKind] of playbookSteps.entries()) {
            const dependsOn = i === 0 ? [] : [insertedIds[i - 1]];
            const ins = await client.query<{ id: string }>(
              `INSERT INTO synthesis_campaign_steps
                 (campaign_id, step_index, kind, status, depends_on)
               VALUES ($1::uuid, $2::int, $3, 'pending', $4::uuid[])
               RETURNING id::text`,
              [campaignRow.id, i, stepKind, dependsOn],
            );
            const inserted = ins.rows[0];
            if (!inserted) throw new Error("synthesis_campaign_step_insert_returned_no_rows");
            insertedIds.push(inserted.id);
          }
          await client.query(
            `UPDATE synthesis_campaigns SET total_steps = $2 WHERE id = $1::uuid`,
            [campaignRow.id, playbookSteps.length],
          );
          campaignRow.total_steps = playbookSteps.length;
        }

        await client.query(
          `INSERT INTO synthesis_campaign_events (campaign_id, event_type, payload)
           VALUES ($1::uuid, 'campaign_created',
             jsonb_build_object('kind', $2::text, 'seeded_steps', $3::int))`,
          [campaignRow.id, input.kind, playbookSteps.length],
        );

        return {
          campaign: rowToCampaign(campaignRow),
          seeded_step_kinds: playbookSteps,
        };
      });
    },
  });
}
