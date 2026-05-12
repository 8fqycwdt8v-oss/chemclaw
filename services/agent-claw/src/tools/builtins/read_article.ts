// read_article — fetch one knowledge-wiki page (current or a past revision),
// with its citations. Phase 1 of ADR 012.
//
// Prefer reading a synthesised page over re-running N retrievals: the page
// already has the cross-referenced synthesis. A `stale: true` flag means the
// backing facts/documents changed and the wiki_pages projector (Phase 2) has
// not yet regenerated the page — read it with that caveat in mind.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";
import {
  ArticleDetailSchema,
  ArticleSlug,
  ARTICLE_SELECT_COLUMNS,
  assertWikiEnabled,
  rowToDetail,
  type ArticleRow,
  type CitationRefT,
} from "./_wiki_shared.js";

export const ReadArticleIn = z
  .object({
    slug: ArticleSlug.optional(),
    id: z.string().uuid().optional(),
    /** When set, return that historical revision's body + citations from
     *  knowledge_article_revisions (the article-row metadata is still the
     *  current head). */
    revision: z.number().int().positive().optional(),
  })
  .refine((v) => v.slug != null || v.id != null, {
    message: "provide either slug or id",
  });
export type ReadArticleInput = z.infer<typeof ReadArticleIn>;

export const ReadArticleOut = z.object({
  found: z.boolean(),
  article: ArticleDetailSchema.nullable(),
});
export type ReadArticleOutput = z.infer<typeof ReadArticleOut>;

export function buildReadArticleTool(pool: Pool) {
  return defineTool({
    id: "read_article",
    description:
      "Read a knowledge-wiki page by slug (e.g. 'compound/<inchikey>', " +
      "'project/<internal_id>', 'topic/<slug>') or by id, with its citations. " +
      "Prefer this over re-running retrievals — the page already synthesises " +
      "what is known. `stale: true` means backing data changed and the page " +
      "has not been regenerated yet. Optionally pass `revision` for history.",
    inputSchema: ReadArticleIn,
    outputSchema: ReadArticleOut,
    annotations: { readOnly: true },

    execute: async (ctx, input) => {
      await assertWikiEnabled(ctx.userEntraId);
      if (!ctx.userEntraId) throw new Error("read_article requires userEntraId");

      return await withUserContext(pool, ctx.userEntraId, async (client) => {
        const where = input.id ? "ka.id = $1::uuid" : "ka.slug = $1";
        const key = input.id ?? input.slug;
        const r = await client.query<ArticleRow>(
          `SELECT ${ARTICLE_SELECT_COLUMNS}
             FROM knowledge_articles ka
            WHERE ${where}
            LIMIT 1`,
          [key],
        );
        const row = r.rows[0];
        if (!row) return ReadArticleOut.parse({ found: false, article: null });

        let citations: CitationRefT[];
        if (input.revision != null && input.revision !== row.revision) {
          // Historical revision: body + citations come from the revision row.
          const rev = await client.query<{ title: string; summary: string | null; body_md: string }>(
            `SELECT title, summary, body_md
               FROM knowledge_article_revisions
              WHERE article_id = $1::uuid AND revision = $2`,
            [row.id, input.revision],
          );
          const revRow = rev.rows[0];
          if (!revRow) {
            throw new Error(
              `read_article: revision ${input.revision} of '${row.slug}' not found`,
            );
          }
          row.title = revRow.title;
          row.summary = revRow.summary;
          row.body_md = revRow.body_md;
          citations = (
            await client.query<{ cite_kind: string; cite_ref: string; anchor: string | null; note: string | null }>(
              `SELECT cite_kind, cite_ref, anchor, note
                 FROM knowledge_article_citations
                WHERE article_id = $1::uuid AND revision = $2
                ORDER BY cite_kind, cite_ref`,
              [row.id, input.revision],
            )
          ).rows.map((c) => ({ cite_kind: c.cite_kind as CitationRefT["cite_kind"], cite_ref: c.cite_ref, anchor: c.anchor, note: c.note }));
        } else {
          citations = (
            await client.query<{ cite_kind: string; cite_ref: string; anchor: string | null; note: string | null }>(
              `SELECT cite_kind, cite_ref, anchor, note
                 FROM knowledge_article_citations
                WHERE article_id = $1::uuid AND revision = $2
                ORDER BY cite_kind, cite_ref`,
              [row.id, row.revision],
            )
          ).rows.map((c) => ({ cite_kind: c.cite_kind as CitationRefT["cite_kind"], cite_ref: c.cite_ref, anchor: c.anchor, note: c.note }));
        }

        return ReadArticleOut.parse({ found: true, article: rowToDetail(row, citations) });
      });
    },
  });
}
