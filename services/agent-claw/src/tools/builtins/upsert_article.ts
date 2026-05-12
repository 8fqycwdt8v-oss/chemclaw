// upsert_article — create or rewrite an agent-authored knowledge-wiki page
// (a `topic/`, `glossary`, or `contradiction/...` page). Phase 1 of ADR 012.
//
// This is the "file the answer back into the wiki" move: after synthesising an
// answer from several sources, persist it as a page so the synthesis compounds
// instead of evaporating into chat history. Cite sources inline as
// `[fact:<uuid>]`, `[chunk:<id>]`, `[experiment:<id>]`, `[article:<slug>]` —
// those are parsed into knowledge_article_citations.
//
// Constraints:
//   * `kind` must be agent-authorable (topic / glossary / contradiction).
//     Entity-backed pages (compound, project, …) are owned by the wiki_pages
//     projector — use `request_article` to ask for one.
//   * The body may not contain `<!-- human:begin ... -->` markers — those are
//     reserved for human edits via PATCH /api/articles/:id (the
//     wiki-human-block-guard pre_tool hook also enforces this).
//   * A page that a human has edited (`has_human_edits`) cannot be overwritten
//     by an agent — `request_article` it to have the projector regenerate
//     around the human blocks, or ask a human to edit it.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withUserContext } from "../../db/with-user-context.js";
import {
  AGENT_AUTHORABLE_KINDS,
  ArticleKind,
  ArticleSlug,
  EntityRef,
  assertWikiEnabled,
  containsHumanBlock,
  parseInlineCitations,
  sessionIdFromScratchpad,
} from "./_wiki_shared.js";

export const UpsertArticleIn = z.object({
  slug: ArticleSlug,
  kind: ArticleKind,
  title: z.string().min(1).max(400),
  summary: z.string().max(1000).optional(),
  body_md: z.string().min(1).max(200_000),
  entity_ref: EntityRef.optional(),
  nce_project_internal_id: z.string().min(1).max(200).optional(),
  change_note: z.string().max(500).optional(),
});
export type UpsertArticleInput = z.infer<typeof UpsertArticleIn>;

export const UpsertArticleOut = z.object({
  article_id: z.string().uuid(),
  slug: z.string(),
  kind: ArticleKind,
  revision: z.number().int().positive(),
  created: z.boolean(),
  citations_recorded: z.number().int().nonnegative(),
});
export type UpsertArticleOutput = z.infer<typeof UpsertArticleOut>;

export function buildUpsertArticleTool(pool: Pool) {
  return defineTool({
    id: "upsert_article",
    description:
      "Create or rewrite an agent-authored knowledge-wiki page (kind: 'topic', " +
      "'glossary', or 'contradiction'). Cite sources inline as [fact:<uuid>], " +
      "[chunk:<id>], [experiment:<id>], [article:<slug>] — they are recorded as " +
      "citations. Use this to persist a synthesised answer so it compounds. " +
      "Cannot overwrite human-edited pages or write entity-backed pages — for " +
      "those, use request_article.",
    inputSchema: UpsertArticleIn,
    outputSchema: UpsertArticleOut,
    annotations: { readOnly: false },

    execute: async (ctx, input) => {
      await assertWikiEnabled(ctx.userEntraId);
      if (!ctx.userEntraId) throw new Error("upsert_article requires userEntraId");

      if (!AGENT_AUTHORABLE_KINDS.has(input.kind)) {
        throw new Error(
          `upsert_article: kind '${input.kind}' is maintained by the wiki_pages ` +
            `projector. Use request_article to request it. Agent-authorable kinds: ` +
            `${[...AGENT_AUTHORABLE_KINDS].join(", ")}.`,
        );
      }
      if (containsHumanBlock(input.body_md)) {
        throw new Error(
          "upsert_article: the body contains a `<!-- human:begin ... -->` marker. " +
            "Those blocks are reserved for human edits via PATCH /api/articles/:id; " +
            "agents must not author them.",
        );
      }

      const citations = parseInlineCitations(input.body_md);
      const sessionId = sessionIdFromScratchpad(ctx.scratchpad);

      return await withUserContext(pool, ctx.userEntraId, async (client) => {
        let projectId: string | null = null;
        if (input.nce_project_internal_id) {
          const proj = await client.query<{ id: string }>(
            `SELECT id::text AS id FROM nce_projects WHERE internal_id = $1`,
            [input.nce_project_internal_id],
          );
          if (!proj.rows[0]) {
            throw new Error(
              `upsert_article: NCE project '${input.nce_project_internal_id}' not found or not accessible.`,
            );
          }
          projectId = proj.rows[0].id;
        }

        const up = await client.query<{ id: string; revision: number }>(
          `INSERT INTO knowledge_articles
             (slug, kind, title, summary, body_md, entity_ref, nce_project_id,
              maturity, dirty, dirty_reason, source_count, created_by, last_edited_by)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::uuid,
                   'EXPLORATORY', false, NULL, $8, $9, $9)
           ON CONFLICT (slug) DO UPDATE SET
             kind           = EXCLUDED.kind,
             title          = EXCLUDED.title,
             summary        = EXCLUDED.summary,
             body_md        = EXCLUDED.body_md,
             entity_ref     = EXCLUDED.entity_ref,
             nce_project_id = EXCLUDED.nce_project_id,
             source_count   = EXCLUDED.source_count,
             dirty          = false,
             dirty_reason   = NULL,
             last_edited_by = EXCLUDED.last_edited_by,
             revision       = knowledge_articles.revision + 1,
             etag           = knowledge_articles.etag + 1,
             updated_at     = NOW()
           WHERE knowledge_articles.has_human_edits = false
           RETURNING id::text AS id, revision`,
          [
            input.slug,
            input.kind,
            input.title,
            input.summary ?? null,
            input.body_md,
            input.entity_ref ? JSON.stringify(input.entity_ref) : null,
            projectId,
            citations.length,
            ctx.userEntraId,
          ],
        );

        const row = up.rows[0];
        if (!row) {
          // Conflict on slug + has_human_edits = true → the WHERE blocked it.
          throw new Error(
            `upsert_article: page '${input.slug}' has human-authored content and ` +
              `cannot be overwritten by an agent. Use request_article to have the ` +
              `wiki_pages projector regenerate it around the human blocks, or ask a ` +
              `human to edit it via the UI.`,
          );
        }

        await client.query(
          `INSERT INTO knowledge_article_revisions
             (article_id, revision, title, summary, body_md,
              author_kind, author_entra_id, agent_session_id, change_note)
           VALUES ($1::uuid, $2, $3, $4, $5, 'agent', $6, $7::uuid, $8)`,
          [
            row.id,
            row.revision,
            input.title,
            input.summary ?? null,
            input.body_md,
            ctx.userEntraId,
            sessionId,
            input.change_note ?? "agent upsert",
          ],
        );

        if (citations.length > 0) {
          await client.query(
            `INSERT INTO knowledge_article_citations (article_id, revision, cite_kind, cite_ref)
             SELECT $1::uuid, $2, k, r FROM unnest($3::text[], $4::text[]) AS t(k, r)
             ON CONFLICT (article_id, revision, cite_kind, cite_ref) DO NOTHING`,
            [
              row.id,
              row.revision,
              citations.map((c) => c.cite_kind),
              citations.map((c) => c.cite_ref),
            ],
          );
        }

        return UpsertArticleOut.parse({
          article_id: row.id,
          slug: input.slug,
          kind: input.kind,
          revision: row.revision,
          created: row.revision === 1,
          citations_recorded: citations.length,
        });
      });
    },
  });
}
