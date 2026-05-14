// Phase 4b-i of ADR 012 (knowledge wiki).
//
// POST /api/admin/articles/:id/maturity — promote / demote a wiki page's
// maturity tier (EXPLORATORY / WORKING / FOUNDATION). The maturity column
// already exists on knowledge_articles (db/init/58_knowledge_wiki.sql:82);
// the agent's `upsert_article` builtin cannot edit it. This admin route
// is the only path to change it, mirroring `POST /api/artifacts/:id/maturity`
// for artifacts.
//
// Audit + RBAC + cache-bust pattern matches admin-flags.ts. The wiki has
// no in-process cache keyed on maturity, so no .invalidate() call is needed.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import { withUserContext } from "../../db/with-user-context.js";
import { guardAdmin } from "../../middleware/require-admin.js";
import { appendAudit } from "./audit-log.js";
import { Maturity } from "../../tools/builtins/_wiki_shared.js";

const IdParam = z.object({ id: z.string().uuid("article id must be a UUID") });

const MaturityBody = z.object({
  tier: Maturity,
  reason: z.string().min(1).max(500).optional(),
});

interface ArticleMaturityRow {
  id: string;
  slug: string;
  kind: string;
  maturity: string;
  revision: number;
  etag: number;
}

export function registerAdminArticlesRoutes(
  app: FastifyInstance,
  pool: Pool,
  getUserEntraId: (req: FastifyRequest) => string,
): void {
  app.post<{ Params: { id: string } }>(
    "/api/admin/articles/:id/maturity",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const callerId = getUserEntraId(req);
      if (!(await guardAdmin(pool, callerId, reply))) return;

      const pr = IdParam.safeParse(req.params);
      if (!pr.success) {
        return await reply.status(400).send({
          error: "invalid_params",
          issues: pr.error.issues,
        });
      }
      const br = MaturityBody.safeParse(req.body);
      if (!br.success) {
        return await reply.status(400).send({
          error: "invalid_input",
          issues: br.error.issues,
        });
      }
      const { id } = pr.data;
      const { tier, reason } = br.data;

      type MaturityResult =
        | { notFound: true }
        | { noop: true; row: ArticleMaturityRow }
        | { ok: true; previousTier: string; after: ArticleMaturityRow };

      const result: MaturityResult = await withUserContext(pool, callerId, async (client) => {
        const before = await client.query<ArticleMaturityRow>(
          `SELECT id::text AS id, slug, kind, maturity, revision, etag::int AS etag
             FROM knowledge_articles
            WHERE id = $1::uuid
            LIMIT 1`,
          [id],
        );
        const prior = before.rows[0];
        if (!prior) return { notFound: true };
        // Capture the previous tier as a primitive — `prior` may be a row
        // reference some drivers reuse if the same object backs the UPDATE
        // RETURNING result.
        const previousTier = prior.maturity;

        if (previousTier === tier) {
          return { noop: true, row: prior };
        }

        // Maturity is a curation attribute, not page content: bump the etag
        // so optimistic-concurrency callers (the PATCH /api/articles/:id
        // editor) re-fetch, but do NOT bump revision and do NOT write a
        // revision row — the body did not change.
        const upd = await client.query<ArticleMaturityRow>(
          `UPDATE knowledge_articles
              SET maturity   = $2,
                  etag       = etag + 1,
                  updated_at = NOW()
            WHERE id = $1::uuid
            RETURNING id::text AS id, slug, kind, maturity, revision, etag::int AS etag`,
          [id, tier],
        );
        const updated = upd.rows[0];
        if (!updated) return { notFound: true };
        return { ok: true, previousTier, after: updated };
      });

      if ("notFound" in result) {
        return await reply.status(404).send({ error: "not_found" });
      }
      if ("noop" in result) {
        const row = result.row;
        return await reply.send({
          article_id: row.id,
          slug: row.slug,
          kind: row.kind,
          maturity: row.maturity,
          etag: row.etag,
          changed: false,
        });
      }

      await appendAudit(pool, {
        actor: callerId,
        action: "knowledge_article.maturity",
        target: result.after.slug,
        beforeValue: { maturity: result.previousTier },
        afterValue: { maturity: result.after.maturity },
        reason,
      });

      return await reply.send({
        article_id: result.after.id,
        slug: result.after.slug,
        kind: result.after.kind,
        maturity: result.after.maturity,
        etag: result.after.etag,
        changed: true,
      });
    },
  );
}
