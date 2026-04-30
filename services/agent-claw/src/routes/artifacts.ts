// POST /api/artifacts/:id/maturity — promote or demote an artifact's maturity tier.
// Phase C.6 — backend for the future frontend's "Promote to WORKING" affordance.
//
// Request body: { tier: "EXPLORATORY" | "WORKING" | "FOUNDATION" }
// RLS-scoped: only the artifact owner can update.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import { withUserContext } from "../db/with-user-context.js";

export interface ArtifactsRouteDeps {
  pool: Pool;
  getUser: (req: FastifyRequest) => string;
}

const MaturityTierSchema = z.object({
  tier: z.enum(["EXPLORATORY", "WORKING", "FOUNDATION"]),
});

const ParamsSchema = z.object({
  id: z.string().uuid("artifact id must be a UUID"),
});

export function registerArtifactsRoutes(
  app: FastifyInstance,
  deps: ArtifactsRouteDeps,
): void {
  // POST /api/artifacts/:id/maturity
  app.post<{ Params: { id: string } }>(
    "/api/artifacts/:id/maturity",
    async (req, reply) => {
      const paramsResult = ParamsSchema.safeParse(req.params);
      if (!paramsResult.success) {
        return await reply.code(400).send({
          error: "invalid_params",
          detail: paramsResult.error.issues,
        });
      }

      const bodyResult = MaturityTierSchema.safeParse(req.body);
      if (!bodyResult.success) {
        return await reply.code(400).send({
          error: "invalid_input",
          detail: bodyResult.error.issues,
        });
      }

      const user = deps.getUser(req);
      const { id } = paramsResult.data;
      const { tier } = bodyResult.data;

      try {
        const updated = await withUserContext(
          deps.pool,
          user,
          async (client) => {
            const result = await client.query<{ id: string; maturity: string }>(
              `UPDATE artifacts
                  SET maturity = $1, updated_at = NOW()
                WHERE id = $2::uuid
                  AND owner_entra_id = $3
              RETURNING id::text AS id, maturity`,
              [tier, id, user],
            );
            return result.rows[0] ?? null;
          },
        );

        if (!updated) {
          return await reply.code(404).send({
            error: "not_found",
            detail: "Artifact not found or not owned by the current user.",
          });
        }

        return await reply.send({
          artifact_id: updated.id,
          maturity: updated.maturity,
        });
      } catch (err) {
        req.log.error({ err }, "artifact maturity update failed");
        return await reply.code(500).send({ error: "internal" });
      }
    },
  );

  // GET /api/artifacts/:id — fetch an artifact (e.g. for a frontend to display ensemble).
  app.get<{ Params: { id: string } }>(
    "/api/artifacts/:id",
    async (req, reply) => {
      const paramsResult = ParamsSchema.safeParse(req.params);
      if (!paramsResult.success) {
        return await reply.code(400).send({
          error: "invalid_params",
          detail: paramsResult.error.issues,
        });
      }

      const user = deps.getUser(req);
      const { id } = paramsResult.data;

      try {
        const artifact = await withUserContext(
          deps.pool,
          user,
          async (client) => {
            const result = await client.query<{
              id: string;
              kind: string;
              payload: unknown;
              maturity: string;
              confidence_ensemble: unknown;
              created_at: string;
            }>(
              `SELECT id::text AS id, kind, payload, maturity,
                      confidence_ensemble, created_at::text AS created_at
                 FROM artifacts
                WHERE id = $1::uuid`,
              [id],
            );
            return result.rows[0] ?? null;
          },
        );

        if (!artifact) {
          return await reply.code(404).send({ error: "not_found" });
        }

        return await reply.send(artifact);
      } catch (err) {
        req.log.error({ err }, "artifact fetch failed");
        return await reply.code(500).send({ error: "internal" });
      }
    },
  );
}
