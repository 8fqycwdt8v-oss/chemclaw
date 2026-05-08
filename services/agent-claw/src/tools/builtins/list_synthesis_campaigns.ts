// list_synthesis_campaigns — list the caller's recent / active synthesis
// campaigns. RLS scopes the result to projects the user can access.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";
import {
  CampaignKind,
  CampaignStatus,
  CampaignSummary,
  rowToCampaign,
  type CampaignRow,
} from "./_synthesis_shared.js";

export const ListSynthesisCampaignsIn = z.object({
  status: z.array(CampaignStatus).optional(),
  kind: z.array(CampaignKind).optional(),
  nce_project_internal_id: z.string().min(1).max(200).optional(),
  only_mine: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(25),
});
export type ListSynthesisCampaignsInput = z.infer<typeof ListSynthesisCampaignsIn>;

export const ListSynthesisCampaignsOut = z.object({
  campaigns: z.array(CampaignSummary),
});
export type ListSynthesisCampaignsOutput = z.infer<typeof ListSynthesisCampaignsOut>;

export function buildListSynthesisCampaignsTool(pool: Pool) {
  return defineTool({
    id: "list_synthesis_campaigns",
    description:
      "List synthesis campaigns visible to the caller, optionally filtered by status, kind, project, or owner. Use to find a resumable campaign for a user before starting a new one.",
    inputSchema: ListSynthesisCampaignsIn,
    outputSchema: ListSynthesisCampaignsOut,
    annotations: { readOnly: true },
    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) throw new Error("list_synthesis_campaigns requires userEntraId");

      return await withUserContext(pool, userEntraId, async (client) => {
        const where: string[] = [];
        const params: unknown[] = [];
        let pIdx = 1;

        if (input.status && input.status.length > 0) {
          where.push(`sc.status = ANY($${pIdx++}::text[])`);
          params.push(input.status);
        }
        if (input.kind && input.kind.length > 0) {
          where.push(`sc.kind = ANY($${pIdx++}::text[])`);
          params.push(input.kind);
        }
        if (input.nce_project_internal_id) {
          where.push(
            `sc.nce_project_id = (SELECT id FROM nce_projects WHERE internal_id = $${pIdx++})`,
          );
          params.push(input.nce_project_internal_id);
        }
        if (input.only_mine) {
          where.push(`sc.created_by_user_entra_id = $${pIdx++}`);
          params.push(userEntraId);
        }

        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
        params.push(input.limit);

        const rows = await client.query<CampaignRow>(
          `SELECT sc.id::text, sc.nce_project_id::text, sc.agent_session_id::text,
                  sc.kind, sc.name, sc.status, sc.goal, sc.policy,
                  sc.total_steps, sc.completed_steps, sc.outcome_summary,
                  to_char(sc.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS created_at,
                  to_char(sc.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS updated_at,
                  sc.etag
             FROM synthesis_campaigns sc
             ${whereSql}
            ORDER BY sc.updated_at DESC
            LIMIT $${pIdx}`,
          params,
        );

        return { campaigns: rows.rows.map(rowToCampaign) };
      });
    },
  });
}
