// request_article — flag a knowledge-wiki page as wanted. Creates a `dirty`
// stub if it does not exist (so there is always something to read), or marks
// an existing page dirty so the wiki_pages projector (Phase 2) regenerates it.
// Phase 1 of ADR 012.
//
// Use this when you notice mid-task that an entity should have a page
// (e.g. `compound/<inchikey>`, `project/<internal_id>`) — entity-backed pages
// are owned by the projector, not authored by agents.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";
import {
  ArticleKind,
  ArticleSlug,
  EntityRef,
  assertWikiEnabled,
} from "./_wiki_shared.js";

export const RequestArticleIn = z.object({
  slug: ArticleSlug,
  kind: ArticleKind,
  title: z.string().min(1).max(400).optional(),
  entity_ref: EntityRef.optional(),
  nce_project_internal_id: z.string().min(1).max(200).optional(),
  reason: z.string().min(1).max(500).optional(),
});
export type RequestArticleInput = z.infer<typeof RequestArticleIn>;

export const RequestArticleOut = z.object({
  article_id: z.string().uuid(),
  slug: z.string(),
  kind: ArticleKind,
  created: z.boolean(),
  dirty: z.boolean(),
  dirty_reason: z.string().nullable(),
});
export type RequestArticleOutput = z.infer<typeof RequestArticleOut>;

export function buildRequestArticleTool(pool: Pool) {
  return defineTool({
    id: "request_article",
    description:
      "Flag a knowledge-wiki page as wanted. Creates a stub (marked dirty) if " +
      "missing, or marks an existing page dirty so the wiki_pages projector " +
      "regenerates it. Use for entity-backed pages (compound/<inchikey>, " +
      "project/<internal_id>, campaign/<uuid>) which agents do not author " +
      "directly.",
    inputSchema: RequestArticleIn,
    outputSchema: RequestArticleOut,
    annotations: { readOnly: false },

    execute: async (ctx, input) => {
      await assertWikiEnabled(ctx.userEntraId);
      if (!ctx.userEntraId) throw new Error("request_article requires userEntraId");

      return await withUserContext(pool, ctx.userEntraId, async (client) => {
        let projectId: string | null = null;
        if (input.nce_project_internal_id) {
          const proj = await client.query<{ id: string }>(
            `SELECT id::text AS id FROM nce_projects WHERE internal_id = $1`,
            [input.nce_project_internal_id],
          );
          if (!proj.rows[0]) {
            throw new Error(
              `request_article: NCE project '${input.nce_project_internal_id}' not found or not accessible.`,
            );
          }
          projectId = proj.rows[0].id;
        }

        const reason = input.reason
          ? `manual:requested (${input.reason.slice(0, 200)})`
          : "manual:requested";

        const r = await client.query<{
          id: string;
          dirty: boolean;
          dirty_reason: string | null;
          revision: number;
        }>(
          `INSERT INTO knowledge_articles
             (slug, kind, title, body_md, entity_ref, nce_project_id,
              maturity, dirty, dirty_reason, created_by)
           VALUES ($1, $2, COALESCE($3, $1), '', $4::jsonb, $5::uuid,
                   'EXPLORATORY', true, $6, $7)
           ON CONFLICT (slug) DO UPDATE SET
             dirty        = true,
             dirty_reason = 'manual:re-requested',
             updated_at   = NOW()
           RETURNING id::text AS id, dirty, dirty_reason, revision`,
          [
            input.slug,
            input.kind,
            input.title ?? null,
            input.entity_ref ? JSON.stringify(input.entity_ref) : null,
            projectId,
            reason,
            ctx.userEntraId,
          ],
        );
        const row = r.rows[0];
        if (!row) throw new Error("request_article: upsert did not return a row");

        return RequestArticleOut.parse({
          article_id: row.id,
          slug: input.slug,
          kind: input.kind,
          created: row.revision === 1 && row.dirty_reason !== "manual:re-requested",
          dirty: row.dirty,
          dirty_reason: row.dirty_reason,
        });
      });
    },
  });
}
