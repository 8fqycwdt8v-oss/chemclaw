// add_synthesis_campaign_step — append a new step to a campaign's DAG.
// Used by the orchestrator when (a) the campaign was created with
// seed_playbook=false, (b) a runtime decision adds a non-default step
// (e.g. an extra QM screen), or (c) a BO campaign needs another bo_round.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";
import {
  JsonRecord,
  StepKind,
  StepSummary,
  rowToStep,
  type StepRow,
} from "./_synthesis_shared.js";

export const AddSynthesisCampaignStepIn = z.object({
  campaign_id: z.string().uuid(),
  kind: StepKind,
  inputs: JsonRecord.default({}),
  notes: z.string().max(2000).optional(),
  depends_on: z.array(z.string().uuid()).max(20).default([]),
  ref_table: z.string().min(1).max(100).optional(),
  ref_id: z.string().min(1).max(200).optional(),
});
export type AddSynthesisCampaignStepInput = z.infer<typeof AddSynthesisCampaignStepIn>;

export const AddSynthesisCampaignStepOut = z.object({
  step: StepSummary,
});
export type AddSynthesisCampaignStepOutput = z.infer<typeof AddSynthesisCampaignStepOut>;

export function buildAddSynthesisCampaignStepTool(pool: Pool) {
  return defineTool({
    id: "add_synthesis_campaign_step",
    description:
      "Append one step (kind ∈ retrosynthesis | condition_design | bo_round | hte_plate_design | …) to an existing synthesis campaign's DAG. Use when the per-kind playbook needs an extra step or when starting from seed_playbook=false. Returns the inserted step.",
    inputSchema: AddSynthesisCampaignStepIn,
    outputSchema: AddSynthesisCampaignStepOut,
    annotations: { readOnly: false },
    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) throw new Error("add_synthesis_campaign_step requires userEntraId");

      return await withUserContext(pool, userEntraId, async (client) => {
        const owns = await client.query<{ id: string }>(
          `SELECT id::text FROM synthesis_campaigns WHERE id = $1::uuid`,
          [input.campaign_id],
        );
        if (owns.rows.length === 0) throw new Error("synthesis_campaign_not_found_or_forbidden");

        const dependsOn = input.depends_on ?? [];
        if (dependsOn.length > 0) {
          const validDeps = await client.query<{ id: string }>(
            `SELECT id::text FROM synthesis_campaign_steps
              WHERE campaign_id = $1::uuid AND id = ANY($2::uuid[])`,
            [input.campaign_id, dependsOn],
          );
          if (validDeps.rows.length !== dependsOn.length) {
            throw new Error("synthesis_campaign_step_depends_on_invalid");
          }
        }

        const next = await client.query<{ next_index: number }>(
          `SELECT COALESCE(MAX(step_index), -1) + 1 AS next_index
             FROM synthesis_campaign_steps
            WHERE campaign_id = $1::uuid`,
          [input.campaign_id],
        );
        const nextIndex = next.rows[0]?.next_index ?? 0;

        const inserted = await client.query<StepRow>(
          `INSERT INTO synthesis_campaign_steps
             (campaign_id, step_index, kind, status, inputs, notes,
              ref_table, ref_id, depends_on)
           VALUES ($1::uuid, $2::int, $3, 'pending', $4::jsonb, $5,
                   $6, $7, $8::uuid[])
           RETURNING id::text, step_index, kind, status,
                     inputs, outputs, notes,
                     ref_table, ref_id,
                     ARRAY(SELECT t::text FROM unnest(depends_on) AS t) AS depends_on,
                     to_char(started_at,   'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS started_at,
                     to_char(completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS completed_at`,
          [
            input.campaign_id,
            nextIndex,
            input.kind,
            JSON.stringify(input.inputs),
            input.notes ?? null,
            input.ref_table ?? null,
            input.ref_id ?? null,
            input.depends_on,
          ],
        );
        const stepRow = inserted.rows[0];
        if (!stepRow) throw new Error("synthesis_campaign_step_insert_returned_no_rows");

        await client.query(
          `UPDATE synthesis_campaigns
              SET total_steps = total_steps + 1,
                  etag = etag + 1
            WHERE id = $1::uuid`,
          [input.campaign_id],
        );

        await client.query(
          `INSERT INTO synthesis_campaign_events (campaign_id, step_id, event_type, payload)
           VALUES ($1::uuid, $2::uuid, 'step_added',
                   jsonb_build_object('kind', $3::text, 'step_index', $4::int))`,
          [input.campaign_id, stepRow.id, input.kind, nextIndex],
        );

        return { step: rowToStep(stepRow) };
      });
    },
  });
}
