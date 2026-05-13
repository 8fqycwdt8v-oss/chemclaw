// list_articles — browse the knowledge-wiki index (the `index` page made
// concrete as a query). Phase 1 of ADR 012.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";
import {
  ArticleKind,
  ArticleSummarySchema,
  Maturity,
  MATURITY_RANK,
  assertWikiEnabled,
  rowToSummary,
  type ArticleRow,
} from "./_wiki_shared.js";

export const ListArticlesIn = z.object({
  kind: z.array(ArticleKind).optional(),
  nce_project_internal_id: z.string().min(1).max(200).optional(),
  /** ILIKE match against slug + title + summary. */
  query: z.string().min(1).max(200).optional(),
  /** Only pages flagged dirty (backing data changed, awaiting regeneration). */
  dirty_only: z.boolean().default(false),
  maturity_min: Maturity.optional(),
  include_archived: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListArticlesInput = z.infer<typeof ListArticlesIn>;

export const ListArticlesOut = z.object({
  articles: z.array(ArticleSummarySchema),
});
export type ListArticlesOutput = z.infer<typeof ListArticlesOut>;

export function buildListArticlesTool(pool: Pool) {
  return defineTool({
    id: "list_articles",
    description:
      "List knowledge-wiki pages visible to the caller, filtered by kind, " +
      "project, free-text, maturity floor, or dirty (stale) status. Use to " +
      "discover whether a page already exists before reading or requesting one.",
    inputSchema: ListArticlesIn,
    outputSchema: ListArticlesOut,
    annotations: { readOnly: true },

    execute: async (ctx, input) => {
      await assertWikiEnabled(ctx.userEntraId);
      if (!ctx.userEntraId) throw new Error("list_articles requires userEntraId");

      return await withUserContext(pool, ctx.userEntraId, async (client) => {
        const where: string[] = [];
        const params: unknown[] = [];
        let p = 1;

        if (!input.include_archived) where.push(`ka.status = 'current'`);
        if (input.kind && input.kind.length > 0) {
          where.push(`ka.kind = ANY($${p++}::text[])`);
          params.push(input.kind);
        }
        if (input.nce_project_internal_id) {
          where.push(
            `ka.nce_project_id = (SELECT id FROM nce_projects WHERE internal_id = $${p++})`,
          );
          params.push(input.nce_project_internal_id);
        }
        if (input.query) {
          where.push(
            `(ka.slug ILIKE $${p} OR ka.title ILIKE $${p} OR COALESCE(ka.summary,'') ILIKE $${p})`,
          );
          params.push(`%${input.query}%`);
          p++;
        }
        if (input.dirty_only) where.push(`ka.dirty`);
        if (input.maturity_min) {
          where.push(
            `(CASE ka.maturity WHEN 'EXPLORATORY' THEN 1 WHEN 'WORKING' THEN 2 WHEN 'FOUNDATION' THEN 3 ELSE 0 END) >= $${p++}`,
          );
          params.push(MATURITY_RANK[input.maturity_min]);
        }

        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
        params.push(input.limit);
        const rows = await client.query<ArticleRow>(
          `SELECT ka.id::text AS id, ka.slug, ka.kind, ka.title, ka.summary,
                  '' AS body_md, NULL AS entity_ref, NULL AS nce_project_id,
                  '' AS group_id, ka.maturity, ka.confidence_score, ka.status,
                  ka.dirty, NULL AS dirty_reason, ka.has_human_edits,
                  ka.source_count, ka.revision, ka.etag,
                  '' AS created_by, NULL AS last_edited_by,
                  to_char(ka.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS updated_at,
                  to_char(ka.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS created_at
             FROM knowledge_articles ka
             ${whereSql}
            ORDER BY ka.updated_at DESC
            LIMIT $${p}`,
          params,
        );
        return ListArticlesOut.parse({ articles: rows.rows.map(rowToSummary) });
      });
    },
  });
}
