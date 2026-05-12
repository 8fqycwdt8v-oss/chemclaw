// /api/articles — read + human-edit surface for the knowledge wiki (ADR 012).
//
//   GET    /api/articles            — list visible pages (the `index`)
//   GET    /api/articles/:id         — read one page (?revision=N for history)
//   PATCH  /api/articles/:id         — human edit: replace body (+ title /
//                                      summary), set has_human_edits, bump
//                                      revision + etag, write a revision row.
//
// Human edits are authoritative: the wiki_pages projector (Phase 2) copies
// `<!-- human:begin ... -->` blocks through verbatim and the wiki_kg projector
// (Phase 3) records the human-owned claims as expert_validated facts.
//
// Whole surface is gated by the `wiki.enabled` feature flag — 404 when off.
// All queries are RLS-scoped via withUserContext (the caller's Entra-ID).

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool, PoolClient } from "pg";

import { withUserContext } from "../db/with-user-context.js";
import { isFeatureEnabled } from "../config/flags.js";
import {
  ARTICLE_SELECT_COLUMNS,
  Maturity,
  MATURITY_RANK,
  parseInlineCitations,
  rowToDetail,
  rowToSummary,
  type ArticleRow,
  type CitationRefT,
} from "../tools/builtins/_wiki_shared.js";

export interface KnowledgeArticlesRouteDeps {
  pool: Pool;
  getUser: (req: FastifyRequest) => string;
}

const IdParam = z.object({ id: z.string().uuid("article id must be a UUID") });

const ListQuery = z.object({
  kind: z.string().min(1).optional(), // comma-separated
  project: z.string().min(1).max(200).optional(),
  query: z.string().min(1).max(200).optional(),
  dirty_only: z.coerce.boolean().optional(),
  maturity_min: Maturity.optional(),
  include_archived: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const GetQuery = z.object({
  revision: z.coerce.number().int().positive().optional(),
});

const PatchBody = z.object({
  title: z.string().min(1).max(400).optional(),
  summary: z.string().max(1000).nullable().optional(),
  body_md: z.string().min(1).max(200_000),
  change_note: z.string().max(500).optional(),
  /** Optimistic-concurrency token; if present and stale, the PATCH 409s. */
  expected_etag: z.number().int().positive().optional(),
});

async function loadCitations(
  client: PoolClient,
  articleId: string,
  revision: number,
): Promise<CitationRefT[]> {
  const r = await client.query<{ cite_kind: string; cite_ref: string; anchor: string | null; note: string | null }>(
    `SELECT cite_kind, cite_ref, anchor, note
       FROM knowledge_article_citations
      WHERE article_id = $1::uuid AND revision = $2
      ORDER BY cite_kind, cite_ref`,
    [articleId, revision],
  );
  return r.rows.map((c) => ({
    cite_kind: c.cite_kind as CitationRefT["cite_kind"],
    cite_ref: c.cite_ref,
    anchor: c.anchor,
    note: c.note,
  }));
}

export function registerKnowledgeArticlesRoutes(
  app: FastifyInstance,
  deps: KnowledgeArticlesRouteDeps,
): void {
  // GET /api/articles
  app.get("/api/articles", async (req, reply) => {
    if (!(await isFeatureEnabled("wiki.enabled", { user: deps.getUser(req) }))) {
      return await reply.code(404).send({ error: "feature_disabled" });
    }
    const q = ListQuery.safeParse(req.query);
    if (!q.success) {
      return await reply.code(400).send({ error: "invalid_query", detail: q.error.issues });
    }
    const user = deps.getUser(req);
    const kinds = q.data.kind
      ? q.data.kind.split(",").map((k) => k.trim()).filter((k) => k.length > 0)
      : undefined;

    try {
      const articles = await withUserContext(deps.pool, user, async (client) => {
        const where: string[] = [];
        const params: unknown[] = [];
        let p = 1;
        if (!q.data.include_archived) where.push(`ka.status = 'current'`);
        if (kinds && kinds.length > 0) {
          where.push(`ka.kind = ANY($${p++}::text[])`);
          params.push(kinds);
        }
        if (q.data.project) {
          where.push(`ka.nce_project_id = (SELECT id FROM nce_projects WHERE internal_id = $${p++})`);
          params.push(q.data.project);
        }
        if (q.data.query) {
          where.push(`(ka.slug ILIKE $${p} OR ka.title ILIKE $${p} OR COALESCE(ka.summary,'') ILIKE $${p})`);
          params.push(`%${q.data.query}%`);
          p++;
        }
        if (q.data.dirty_only) where.push(`ka.dirty`);
        if (q.data.maturity_min) {
          where.push(
            `(CASE ka.maturity WHEN 'EXPLORATORY' THEN 1 WHEN 'WORKING' THEN 2 WHEN 'FOUNDATION' THEN 3 ELSE 0 END) >= $${p++}`,
          );
          params.push(MATURITY_RANK[q.data.maturity_min]);
        }
        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
        params.push(q.data.limit ?? 50);
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
        return rows.rows.map(rowToSummary);
      });
      return await reply.send({ articles });
    } catch (err) {
      req.log.error({ err }, "list articles failed");
      return await reply.code(500).send({ error: "internal" });
    }
  });

  // GET /api/articles/:id
  app.get<{ Params: { id: string } }>("/api/articles/:id", async (req, reply) => {
    if (!(await isFeatureEnabled("wiki.enabled", { user: deps.getUser(req) }))) {
      return await reply.code(404).send({ error: "feature_disabled" });
    }
    const pr = IdParam.safeParse(req.params);
    if (!pr.success) {
      return await reply.code(400).send({ error: "invalid_params", detail: pr.error.issues });
    }
    const qr = GetQuery.safeParse(req.query);
    if (!qr.success) {
      return await reply.code(400).send({ error: "invalid_query", detail: qr.error.issues });
    }
    const user = deps.getUser(req);
    try {
      const article = await withUserContext(deps.pool, user, async (client) => {
        const r = await client.query<ArticleRow>(
          `SELECT ${ARTICLE_SELECT_COLUMNS}
             FROM knowledge_articles ka
            WHERE ka.id = $1::uuid
            LIMIT 1`,
          [pr.data.id],
        );
        const row = r.rows[0];
        if (!row) return null;
        let citations: CitationRefT[];
        if (qr.data.revision != null && qr.data.revision !== row.revision) {
          const rev = await client.query<{ title: string; summary: string | null; body_md: string }>(
            `SELECT title, summary, body_md FROM knowledge_article_revisions
              WHERE article_id = $1::uuid AND revision = $2`,
            [row.id, qr.data.revision],
          );
          if (!rev.rows[0]) return null;
          row.title = rev.rows[0].title;
          row.summary = rev.rows[0].summary;
          row.body_md = rev.rows[0].body_md;
          citations = await loadCitations(client, row.id, qr.data.revision);
        } else {
          citations = await loadCitations(client, row.id, row.revision);
        }
        return rowToDetail(row, citations);
      });
      if (!article) return await reply.code(404).send({ error: "not_found" });
      return await reply.send(article);
    } catch (err) {
      req.log.error({ err }, "read article failed");
      return await reply.code(500).send({ error: "internal" });
    }
  });

  // PATCH /api/articles/:id — human edit.
  app.patch<{ Params: { id: string } }>("/api/articles/:id", async (req, reply) => {
    if (!(await isFeatureEnabled("wiki.enabled", { user: deps.getUser(req) }))) {
      return await reply.code(404).send({ error: "feature_disabled" });
    }
    const pr = IdParam.safeParse(req.params);
    if (!pr.success) {
      return await reply.code(400).send({ error: "invalid_params", detail: pr.error.issues });
    }
    const br = PatchBody.safeParse(req.body);
    if (!br.success) {
      return await reply.code(400).send({ error: "invalid_input", detail: br.error.issues });
    }
    const user = deps.getUser(req);
    const { id } = pr.data;
    const body = br.data;
    const summaryProvided = body.summary !== undefined;

    try {
      const result = await withUserContext(deps.pool, user, async (client) => {
        const upd = await client.query<{ id: string; slug: string; kind: string; revision: number; etag: number }>(
          `UPDATE knowledge_articles SET
             title          = CASE WHEN $2::boolean THEN $3 ELSE title END,
             summary        = CASE WHEN $4::boolean THEN $5 ELSE summary END,
             body_md        = $6,
             has_human_edits = true,
             dirty          = false,
             dirty_reason   = NULL,
             last_edited_by = $7,
             revision       = revision + 1,
             etag           = etag + 1,
             updated_at     = NOW()
           WHERE id = $1::uuid
             AND ($8::bigint IS NULL OR etag = $8::bigint)
           RETURNING id::text AS id, slug, kind, revision, etag::int AS etag`,
          [
            id,
            body.title !== undefined,
            body.title ?? null,
            summaryProvided,
            body.summary ?? null,
            body.body_md,
            user,
            body.expected_etag ?? null,
          ],
        );
        const row = upd.rows[0];
        if (!row) {
          // Distinguish 404 (not visible / not found) from 409 (etag stale).
          const exists = await client.query<{ etag: number }>(
            `SELECT etag::int AS etag FROM knowledge_articles WHERE id = $1::uuid`,
            [id],
          );
          if (exists.rows[0]) {
            return { conflict: true as const, currentEtag: exists.rows[0].etag };
          }
          return { notFound: true as const };
        }

        await client.query(
          `INSERT INTO knowledge_article_revisions
             (article_id, revision, title, summary, body_md, author_kind, author_entra_id, change_note)
           SELECT $1::uuid, $2, title, summary, body_md, 'human', $3, $4
             FROM knowledge_articles WHERE id = $1::uuid`,
          [row.id, row.revision, user, body.change_note ?? "human edit"],
        );

        const citations = parseInlineCitations(body.body_md);
        if (citations.length > 0) {
          await client.query(
            `INSERT INTO knowledge_article_citations (article_id, revision, cite_kind, cite_ref)
             SELECT $1::uuid, $2, k, r FROM unnest($3::text[], $4::text[]) AS t(k, r)
             ON CONFLICT (article_id, revision, cite_kind, cite_ref) DO NOTHING`,
            [row.id, row.revision, citations.map((c) => c.cite_kind), citations.map((c) => c.cite_ref)],
          );
        }
        return { ok: true as const, row, citations: citations.length };
      });

      if ("notFound" in result) return await reply.code(404).send({ error: "not_found" });
      if ("conflict" in result) {
        return await reply.code(409).send({ error: "etag_conflict", current_etag: result.currentEtag });
      }
      return await reply.send({
        article_id: result.row.id,
        slug: result.row.slug,
        kind: result.row.kind,
        revision: result.row.revision,
        etag: result.row.etag,
        has_human_edits: true,
        citations_recorded: result.citations,
      });
    } catch (err) {
      req.log.error({ err }, "patch article failed");
      return await reply.code(500).send({ error: "internal" });
    }
  });

}
