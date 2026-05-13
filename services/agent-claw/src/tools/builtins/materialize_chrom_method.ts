// materialize_chrom_method — turn a BO proposal into an executable
// chromatography method and persist it as an analytical_methods row.
//
// Inputs: a campaign / round id and the proposal index (within the round's
// proposals array). The builtin reads the proposal's factor_values, calls
// mcp_chrom_method_optimizer /materialize_method to expand the gradient
// shape into a (time_min, pctB) table, then inserts an analytical_methods
// row with column FK + b_solvent + additive + flow + T + detection_mode +
// gradient_program. The chemist can then queue the method file on a
// method-development pump.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";

export const MaterializeChromMethodIn = z.object({
  round_id: z.string().uuid(),
  proposal_index: z.number().int().min(0).max(199),
  method_name: z.string().min(1).max(200),
  detection_mode: z.enum(["DAD", "MS", "ELSD", "CAD", "RID", "MS-DAD"]).default("DAD"),
  technique: z.enum(["RP-HPLC", "RP-UHPLC", "HILIC", "SFC"]).default("RP-UHPLC"),
  gradient_scheme: z.enum(["linear", "hold_ramp_hold", "multi_segment"]).default("hold_ramp_hold"),
  injection_volume_uL: z.number().min(0.1).max(50.0).default(2.0),
});
export type MaterializeChromMethodInput = z.infer<typeof MaterializeChromMethodIn>;

export const MaterializeChromMethodOut = z.object({
  method_id: z.string().uuid(),
  method_name: z.string(),
  column_id: z.string().uuid(),
  total_runtime_min: z.number(),
  gradient_program: z.array(z.object({
    time_min: z.number(),
    pctB: z.number(),
  })),
});
export type MaterializeChromMethodOutput = z.infer<typeof MaterializeChromMethodOut>;

const MaterializeOut = z.object({
  technique: z.string(),
  column: z.string(),
  b_solvent: z.string(),
  additive: z.string(),
  flow_mLmin: z.number(),
  T_col_C: z.number(),
  detection_mode: z.string(),
  gradient_program: z.array(z.object({
    time_min: z.number(),
    pctB: z.number(),
  })),
  total_runtime_min: z.number(),
});

const TIMEOUT_MS = 15_000;

interface RoundLookup {
  campaign_id: string;
  proposals: unknown;
  nce_project_id: string;
}

export function buildMaterializeChromMethodTool(pool: Pool, optimizerUrl: string) {
  const base = optimizerUrl.replace(/\/$/, "");
  return defineTool({
    id: "materialize_chrom_method",
    description:
      "Turn a BO proposal from a chromatography optimization round into an " +
      "executable HPLC method: expands the gradient-shape factors into an " +
      "explicit (time_min, pctB) table, persists an analytical_methods row " +
      "(RLS-scoped to the campaign's project), returns the method_id and " +
      "gradient program. The chemist can then queue the method file on the " +
      "method-development pump.",
    inputSchema: MaterializeChromMethodIn,
    outputSchema: MaterializeChromMethodOut,
    annotations: { readOnly: false },

    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("materialize_chrom_method requires userEntraId in context");
      }

      // 1. Pull the round + proposal under RLS.
      const lookup = await withUserContext(pool, userEntraId, async (client) => {
        const r = await client.query<RoundLookup>(
          `SELECT r.campaign_id::text, r.proposals, c.nce_project_id::text
             FROM optimization_rounds r
             JOIN optimization_campaigns c ON c.id = r.campaign_id
            WHERE r.id = $1`,
          [input.round_id],
        );
        const row = r.rows[0];
        if (row === undefined) {
          throw new Error("round_not_found");
        }
        return row;
      });

      if (!Array.isArray(lookup.proposals)) {
        throw new Error("proposals_corrupt");
      }
      const proposal = (lookup.proposals as Array<{ factor_values?: unknown }>)[
        input.proposal_index
      ];
      if (proposal === undefined) {
        throw new Error("proposal_index_out_of_range");
      }
      const factorValues = (proposal.factor_values ?? {}) as Record<string, unknown>;

      // 2. Compile via the MCP. Pure deterministic — no GP fit.
      const compiled = await postJson(
        `${base}/materialize_method`,
        {
          factor_values: factorValues,
          gradient_scheme: input.gradient_scheme,
          detection_mode: input.detection_mode,
          technique: input.technique,
        },
        MaterializeOut,
        TIMEOUT_MS,
        "mcp-chrom-method-optimizer",
      );

      // 3. Persist the method (RLS-scoped via nce_project_id).
      const persisted = await withUserContext(pool, userEntraId, async (client) => {
        // Resolve the column_id as a UUID — the proposal carried the
        // column_inventory.id string.
        const colRes = await client.query<{ id: string }>(
          `SELECT id::text FROM column_inventory WHERE id::text = $1 AND active = true`,
          [compiled.column],
        );
        const columnId = colRes.rows[0]?.id;
        if (columnId === undefined) {
          throw new Error("column_inventory_id_not_found_or_inactive");
        }
        const result = await client.query<{ id: string }>(
          `INSERT INTO analytical_methods
             (nce_project_id, campaign_id, round_id, method_name, technique,
              column_id, b_solvent, additive, flow_mLmin, T_col_C,
              detection_mode, gradient_program, injection_volume_uL,
              total_runtime_min, created_by_user_entra_id)
           VALUES ($1, $2, $3, $4, $5,
                   $6, $7, $8, $9, $10,
                   $11, $12::jsonb, $13,
                   $14, $15)
           RETURNING id::text`,
          [
            lookup.nce_project_id,
            lookup.campaign_id,
            input.round_id,
            input.method_name,
            input.technique,
            columnId,
            compiled.b_solvent,
            compiled.additive,
            compiled.flow_mLmin,
            compiled.T_col_C,
            input.detection_mode,
            JSON.stringify(compiled.gradient_program),
            input.injection_volume_uL,
            compiled.total_runtime_min,
            userEntraId,
          ],
        );
        const row = result.rows[0];
        if (!row) {
          throw new Error("analytical_method insert returned no row");
        }
        return row;
      });

      return MaterializeChromMethodOut.parse({
        method_id: persisted.id,
        method_name: input.method_name,
        column_id: compiled.column,
        total_runtime_min: compiled.total_runtime_min,
        gradient_program: compiled.gradient_program,
      });
    },
  });
}
