// update_hypothesis_status — Tranche 1 / C3 builtin.
//
// The `kg_hypotheses` projector subscribes to `hypothesis_status_changed`
// events but until Tranche 1 no code path emitted them. This tool gives the
// agent a way to refute / archive / confirm a hypothesis it previously
// proposed; the actual event emission is handled by the
// `trg_hypotheses_status_event` trigger added in
// db/init/35_event_type_vocabulary.sql so the tool can do nothing more than
// run the UPDATE inside the user's RLS context.
//
// RLS: `hypotheses_owner_update` (db/init/03_hypotheses.sql:69) restricts
// UPDATE to the hypothesis owner. The withUserContext wrapper sets
// `app.current_user_entra_id`; if the caller doesn't own the row the UPDATE
// returns zero rows and the tool throws.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";

// ---------- Schemas ----------------------------------------------------------

const STATUS_VALUES = ["proposed", "confirmed", "refuted", "archived"] as const;

export const UpdateHypothesisStatusIn = z.object({
  hypothesis_id: z
    .string()
    .uuid()
    .describe("UUID of the hypothesis to transition."),
  new_status: z
    .enum(STATUS_VALUES)
    .describe(
      "Target status. 'refuted' also stamps refuted_at; 'confirmed' and " +
        "'archived' transitions are recorded but do not set refuted_at.",
    ),
});
export type UpdateHypothesisStatusInput = z.infer<typeof UpdateHypothesisStatusIn>;

export const UpdateHypothesisStatusOut = z.object({
  hypothesis_id: z.string().uuid(),
  old_status: z.enum(STATUS_VALUES),
  new_status: z.enum(STATUS_VALUES),
  refuted_at: z.string().nullable(),
  projection_status: z.literal("pending"),
});
export type UpdateHypothesisStatusOutput = z.infer<typeof UpdateHypothesisStatusOut>;

// ---------- Factory ----------------------------------------------------------

export function buildUpdateHypothesisStatusTool(pool: Pool) {
  return defineTool({
    id: "update_hypothesis_status",
    description:
      "Transition a hypothesis to a new status (proposed | confirmed | " +
      "refuted | archived). On 'refuted', stamps refuted_at = NOW(). " +
      "Emits hypothesis_status_changed via DB trigger so the kg-hypotheses " +
      "projector picks it up. Caller must own the hypothesis.",
    inputSchema: UpdateHypothesisStatusIn,
    outputSchema: UpdateHypothesisStatusOut,

    execute: async (ctx, input) => {
      const result = await withUserContext(pool, ctx.userEntraId, async (client) => {
        // Single UPDATE; the trigger trg_hypotheses_status_event handles the
        // event emission whenever OLD.status IS DISTINCT FROM NEW.status.
        // refuted_at is set additively (only when transitioning TO refuted)
        // so a re-confirmation doesn't clobber the original refutation
        // timestamp by accident.
        const { rows } = await client.query<{
          id: string;
          old_status: (typeof STATUS_VALUES)[number];
          new_status: (typeof STATUS_VALUES)[number];
          refuted_at: Date | string | null;
        }>(
          `WITH prev AS (
             SELECT id, status FROM hypotheses WHERE id = $1::uuid
           )
           UPDATE hypotheses h
              SET status     = $2,
                  refuted_at = CASE
                    WHEN $2 = 'refuted' AND h.refuted_at IS NULL THEN NOW()
                    ELSE h.refuted_at
                  END
            FROM prev
            WHERE h.id = prev.id
              AND prev.status IS DISTINCT FROM $2
          RETURNING h.id::text                AS id,
                    prev.status               AS old_status,
                    h.status                  AS new_status,
                    h.refuted_at              AS refuted_at`,
          [input.hypothesis_id, input.new_status],
        );
        return rows[0] ?? null;
      });

      if (!result) {
        // Either the hypothesis doesn't exist, the caller doesn't own it
        // (RLS update policy), or the new status equals the old one
        // (no-op). All three are surfaced as a single error so the agent
        // can re-plan rather than silently succeeding on a no-op.
        throw new Error(
          `update_hypothesis_status: no transition applied for ${input.hypothesis_id}. ` +
            "Either the hypothesis does not exist, is not owned by the caller, " +
            "or is already in the requested status.",
        );
      }

      const refutedAt: string | null =
        result.refuted_at instanceof Date
          ? result.refuted_at.toISOString()
          : result.refuted_at;

      return UpdateHypothesisStatusOut.parse({
        hypothesis_id: result.id,
        old_status: result.old_status,
        new_status: result.new_status,
        refuted_at: refutedAt,
        projection_status: "pending",
      });
    },
  });
}
