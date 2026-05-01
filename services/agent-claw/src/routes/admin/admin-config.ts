// Phase 2 of the configuration concept (Initiative 1).
//
// /api/admin/config/* — read / set / delete config_settings rows.
// All endpoints require global_admin OR a matching scoped-admin role
// (org_admin for scope=org, project_admin for scope=project). Mutations
// invalidate the in-process ConfigRegistry cache via the shared singleton
// so changes propagate without waiting for the 60s TTL.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import { withUserContext } from "../../db/with-user-context.js";
import { isAdmin, guardAdmin } from "../../middleware/require-admin.js";
import { appendAudit } from "./audit-log.js";
import { getConfigRegistry } from "../../config/registry.js";

const SCOPE_VALUES = ["global", "org", "project", "user"] as const;

const SetBody = z.object({
  value: z.unknown(),
  description: z.string().max(500).optional(),
  reason: z.string().min(1).max(500).optional(),
});

const ListQuery = z.object({
  scope: z.enum(SCOPE_VALUES).optional(),
  scope_id: z.string().max(200).optional(),
  key_prefix: z.string().max(200).optional(),
});

interface ConfigRow {
  scope: string;
  scope_id: string;
  key: string;
  value: unknown;
  description: string | null;
  updated_at: string;
  updated_by: string;
}

/**
 * Mutating a row at scope=org requires either global_admin OR org_admin
 * for that specific scope_id. Same for project. user-scoped rows are
 * always admin-only (we don't expose self-edit).
 */
async function adminAllowedForScope(
  pool: Pool,
  callerId: string,
  scope: string,
  scopeId: string,
): Promise<boolean> {
  if (await isAdmin(pool, callerId, "global_admin")) return true;
  if (scope === "org" && (await isAdmin(pool, callerId, "org_admin", scopeId))) return true;
  if (scope === "project" && (await isAdmin(pool, callerId, "project_admin", scopeId))) return true;
  return false;
}

export function registerAdminConfigRoutes(
  app: FastifyInstance,
  pool: Pool,
  getUserEntraId: (req: FastifyRequest) => string,
): void {

  // GET /api/admin/config — list all settings (filterable). Requires global_admin.
  app.get("/api/admin/config", async (req: FastifyRequest, reply: FastifyReply) => {
    const callerId = getUserEntraId(req);
    if (!(await guardAdmin(pool, callerId, reply))) return;

    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      return await reply.status(400).send({
        error: "Invalid query.",
        issues: parsed.error.issues,
      });
    }
    const { scope, scope_id, key_prefix } = parsed.data;

    const rows = await withUserContext(pool, callerId, async (client) => {
      const conds: string[] = [];
      const params: unknown[] = [];
      const push = (clause: string, value: unknown) => {
        params.push(value);
        conds.push(clause.replace("$?", `$${params.length}`));
      };
      if (scope)      push("scope = $?",            scope);
      if (scope_id)   push("scope_id = $?",         scope_id);
      if (key_prefix) push("key LIKE $? || '%'",    key_prefix);
      const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
      const { rows } = await client.query<ConfigRow>(
        `SELECT scope, scope_id, key, value, description, updated_at, updated_by
           FROM config_settings
           ${where}
          ORDER BY scope, scope_id, key`,
        params,
      );
      return rows;
    });

    return await reply.send({ settings: rows, count: rows.length });
  });

  // PATCH /api/admin/config/:scope/:scope_id?key=X — upsert a row.
  app.patch(
    "/api/admin/config/:scope/:scope_id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const callerId = getUserEntraId(req);
      const { scope, scope_id } = req.params as { scope: string; scope_id: string };
      const { key } = req.query as { key?: string };

      if (!SCOPE_VALUES.includes(scope as (typeof SCOPE_VALUES)[number])) {
        return await reply.status(400).send({ error: `Invalid scope '${scope}'.` });
      }
      if (!key || key.length > 200) {
        return await reply.status(400).send({ error: "Missing or oversize 'key' query param." });
      }

      const realScopeId = scope === "global" ? "" : scope_id;
      if (scope === "global" && scope_id !== "_") {
        return await reply.status(400).send({
          error: "global scope must use scope_id='_' as placeholder.",
        });
      }
      if (scope !== "global" && !scope_id) {
        return await reply.status(400).send({
          error: `${scope} requires a non-empty scope_id.`,
        });
      }

      if (!(await adminAllowedForScope(pool, callerId, scope, realScopeId))) {
        return await reply.status(403).send({
          error: `Permission denied. Requires global_admin or ${scope}_admin on '${realScopeId}'.`,
        });
      }

      const parsed = SetBody.safeParse(req.body);
      if (!parsed.success) {
        return await reply.status(400).send({
          error: "Invalid body.",
          issues: parsed.error.issues,
        });
      }
      const { value, description, reason } = parsed.data;

      const before = await withUserContext(pool, callerId, async (client) => {
        const { rows } = await client.query<{ value: unknown }>(
          `SELECT value FROM config_settings
            WHERE scope = $1 AND scope_id = $2 AND key = $3`,
          [scope, realScopeId, key],
        );
        return rows[0]?.value ?? null;
      });

      await withUserContext(pool, callerId, async (client) => {
        await client.query(
          `INSERT INTO config_settings
             (scope, scope_id, key, value, description, updated_by)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6)
           ON CONFLICT (scope, scope_id, key) DO UPDATE
             SET value = EXCLUDED.value,
                 description = COALESCE(EXCLUDED.description, config_settings.description),
                 updated_at = NOW(),
                 updated_by = EXCLUDED.updated_by`,
          [scope, realScopeId, key, JSON.stringify(value), description ?? null, callerId],
        );
      });

      await appendAudit(pool, {
        actor: callerId,
        action: "config.set",
        target: `${scope}:${realScopeId}:${key}`,
        beforeValue: before,
        afterValue: value,
        reason,
      });

      // Bust the in-process cache so the next read sees the new value.
      try {
        getConfigRegistry().invalidate(key);
      } catch {
        // Singleton not set up (tests construct routes without bootstrap);
        // no-op so the route still functions.
      }

      return await reply.send({
        ok: true,
        scope,
        scope_id: realScopeId,
        key,
      });
    },
  );

  // DELETE /api/admin/config/:scope/:scope_id?key=X — remove a row.
  app.delete(
    "/api/admin/config/:scope/:scope_id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const callerId = getUserEntraId(req);
      const { scope, scope_id } = req.params as { scope: string; scope_id: string };
      const { key } = req.query as { key?: string };

      if (!SCOPE_VALUES.includes(scope as (typeof SCOPE_VALUES)[number])) {
        return await reply.status(400).send({ error: `Invalid scope '${scope}'.` });
      }
      if (!key) return await reply.status(400).send({ error: "Missing 'key' query param." });

      const realScopeId = scope === "global" ? "" : scope_id;
      if (scope === "global" && scope_id !== "_") {
        return await reply.status(400).send({
          error: "global scope must use scope_id='_' as placeholder.",
        });
      }

      if (!(await adminAllowedForScope(pool, callerId, scope, realScopeId))) {
        return await reply.status(403).send({
          error: `Permission denied. Requires global_admin or ${scope}_admin on '${realScopeId}'.`,
        });
      }

      const before = await withUserContext(pool, callerId, async (client) => {
        const { rows } = await client.query<{ value: unknown }>(
          `DELETE FROM config_settings
            WHERE scope = $1 AND scope_id = $2 AND key = $3
          RETURNING value`,
          [scope, realScopeId, key],
        );
        return rows[0]?.value ?? null;
      });

      if (before !== null) {
        await appendAudit(pool, {
          actor: callerId,
          action: "config.delete",
          target: `${scope}:${realScopeId}:${key}`,
          beforeValue: before,
        });
      }

      try {
        getConfigRegistry().invalidate(key);
      } catch {
        // singleton not initialised in unit-test contexts
      }

      return await reply.send({ deleted: before !== null, scope, scope_id: realScopeId, key });
    },
  );
}
