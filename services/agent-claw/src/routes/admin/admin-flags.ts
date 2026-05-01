// Phase 2 of the configuration concept (Initiative 6).
//
// /api/admin/feature-flags — discover, upsert, delete feature flags.
// All endpoints require global_admin. Mutations bust the in-process cache
// via the FeatureFlagRegistry singleton so changes propagate immediately.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import { withUserContext } from "../../db/with-user-context.js";
import { guardAdmin } from "../../middleware/require-admin.js";
import { appendAudit } from "./audit-log.js";
import { getFeatureFlagRegistry } from "../../config/flags.js";

const ScopeRule = z.object({
  orgs: z.array(z.string().min(1).max(200)).max(50).optional(),
  projects: z.array(z.string().min(1).max(200)).max(200).optional(),
  users: z.array(z.string().min(1).max(200)).max(200).optional(),
});

const UpsertBody = z.object({
  enabled: z.boolean(),
  description: z.string().min(1).max(500),
  scope_rule: ScopeRule.nullish(),
  reason: z.string().min(1).max(500).optional(),
});

interface FlagRow {
  key: string;
  enabled: boolean;
  scope_rule: unknown;
  description: string;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

export function registerAdminFlagsRoutes(
  app: FastifyInstance,
  pool: Pool,
  getUserEntraId: (req: FastifyRequest) => string,
): void {

  // GET /api/admin/feature-flags — catalog of all flags.
  app.get("/api/admin/feature-flags", async (req: FastifyRequest, reply: FastifyReply) => {
    const callerId = getUserEntraId(req);
    if (!(await guardAdmin(pool, callerId, reply))) return;

    const rows = await withUserContext(pool, callerId, async (client) => {
      const { rows } = await client.query<FlagRow>(
        `SELECT key, enabled, scope_rule, description, created_at, updated_at, updated_by
           FROM feature_flags
          ORDER BY key`,
      );
      return rows;
    });
    return await reply.send({ flags: rows, count: rows.length });
  });

  // POST /api/admin/feature-flags/:key — upsert a flag (description required on insert).
  app.post(
    "/api/admin/feature-flags/:key",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const callerId = getUserEntraId(req);
      if (!(await guardAdmin(pool, callerId, reply))) return;

      const { key } = req.params as { key: string };
      if (!key || key.length > 200 || !/^[a-z0-9_.]+$/i.test(key)) {
        return await reply.status(400).send({
          error: "Invalid key. Allowed: alphanumerics, underscore, dot.",
        });
      }

      const parsed = UpsertBody.safeParse(req.body);
      if (!parsed.success) {
        return await reply.status(400).send({
          error: "Invalid body.",
          issues: parsed.error.issues,
        });
      }
      const { enabled, description, scope_rule, reason } = parsed.data;

      const before = await withUserContext(pool, callerId, async (client) => {
        const { rows } = await client.query<{ enabled: boolean; scope_rule: unknown; description: string }>(
          `SELECT enabled, scope_rule, description FROM feature_flags WHERE key = $1`,
          [key],
        );
        return rows[0] ?? null;
      });

      await withUserContext(pool, callerId, async (client) => {
        await client.query(
          `INSERT INTO feature_flags (key, enabled, scope_rule, description, updated_by)
             VALUES ($1, $2, $3::jsonb, $4, $5)
           ON CONFLICT (key) DO UPDATE
             SET enabled = EXCLUDED.enabled,
                 scope_rule = EXCLUDED.scope_rule,
                 description = EXCLUDED.description,
                 updated_at = NOW(),
                 updated_by = EXCLUDED.updated_by`,
          [
            key,
            enabled,
            scope_rule === undefined || scope_rule === null ? null : JSON.stringify(scope_rule),
            description,
            callerId,
          ],
        );
      });

      await appendAudit(pool, {
        actor: callerId,
        action: before ? "feature_flag.update" : "feature_flag.create",
        target: key,
        beforeValue: before,
        afterValue: { enabled, scope_rule: scope_rule ?? null, description },
        reason,
      });

      try {
        getFeatureFlagRegistry().invalidate();
      } catch {
        // singleton not initialised in unit-test contexts
      }

      return await reply.send({ ok: true, key, enabled });
    },
  );

  // DELETE /api/admin/feature-flags/:key — remove a flag entirely.
  app.delete(
    "/api/admin/feature-flags/:key",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const callerId = getUserEntraId(req);
      if (!(await guardAdmin(pool, callerId, reply))) return;

      const { key } = req.params as { key: string };
      const before = await withUserContext(pool, callerId, async (client) => {
        const { rows } = await client.query<FlagRow>(
          `DELETE FROM feature_flags WHERE key = $1
           RETURNING key, enabled, scope_rule, description, created_at, updated_at, updated_by`,
          [key],
        );
        return rows[0] ?? null;
      });

      if (before) {
        await appendAudit(pool, {
          actor: callerId,
          action: "feature_flag.delete",
          target: key,
          beforeValue: { enabled: before.enabled, scope_rule: before.scope_rule, description: before.description },
        });
      }

      try {
        getFeatureFlagRegistry().invalidate();
      } catch {
        // singleton not initialised in unit-test contexts
      }

      return await reply.send({ deleted: before !== null, key });
    },
  );
}
