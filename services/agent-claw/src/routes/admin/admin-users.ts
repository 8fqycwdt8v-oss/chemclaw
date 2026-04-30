// Phase 1 of the configuration concept (Initiative 2).
//
// Endpoints for managing admin role grants. These replace the AGENT_ADMIN_USERS
// env-var workflow with audited DB rows.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import { withUserContext } from "../../db/with-user-context.js";
import { guardAdmin, type AdminRole } from "../../middleware/require-admin.js";
import { appendAudit } from "./audit-log.js";

const ROLE_VALUES = ["global_admin", "org_admin", "project_admin"] as const;

const GrantBody = z.object({
  role: z.enum(ROLE_VALUES),
  scope_id: z.string().max(200).default(""),
  reason: z.string().min(1).max(500).optional(),
});

const RevokeQuery = z.object({
  role: z.enum(ROLE_VALUES),
  scope_id: z.string().max(200).default(""),
});

export interface AdminRoleRow {
  user_entra_id: string;
  role: AdminRole;
  scope_id: string;
  granted_at: string;
  granted_by: string;
}

export function registerAdminUsersRoutes(
  app: FastifyInstance,
  pool: Pool,
  getUserEntraId: (req: FastifyRequest) => string,
): void {

  // GET /api/admin/users/:entra_id/admin-roles — list all role grants for a user.
  app.get(
    "/api/admin/users/:entra_id/admin-roles",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const callerId = getUserEntraId(req);
      if (!(await guardAdmin(pool, callerId, reply))) return;

      const { entra_id } = req.params as { entra_id: string };
      const rows = await withUserContext(pool, callerId, async (client) => {
        const { rows } = await client.query<AdminRoleRow>(
          `SELECT user_entra_id, role, scope_id, granted_at, granted_by
             FROM admin_roles
            WHERE user_entra_id = $1
            ORDER BY role, scope_id`,
          [entra_id],
        );
        return rows;
      });
      return await reply.send({ user_entra_id: entra_id, roles: rows });
    },
  );

  // POST /api/admin/users/:entra_id/admin-role — grant a role.
  app.post(
    "/api/admin/users/:entra_id/admin-role",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const callerId = getUserEntraId(req);
      if (!(await guardAdmin(pool, callerId, reply))) return;

      const { entra_id } = req.params as { entra_id: string };
      const parsed = GrantBody.safeParse(req.body);
      if (!parsed.success) {
        return await reply.status(400).send({
          error: "Invalid body.",
          issues: parsed.error.issues,
        });
      }
      const { role, scope_id, reason } = parsed.data;

      // Scoped roles must carry a non-empty scope_id; global_admin must not.
      if (role === "global_admin" && scope_id !== "") {
        return await reply.status(400).send({
          error: "global_admin must have empty scope_id.",
        });
      }
      if (role !== "global_admin" && scope_id === "") {
        return await reply.status(400).send({
          error: `${role} requires a non-empty scope_id.`,
        });
      }

      const target = entra_id.toLowerCase();
      const inserted = await withUserContext(pool, callerId, async (client) => {
        const { rows } = await client.query<AdminRoleRow>(
          `INSERT INTO admin_roles (user_entra_id, role, scope_id, granted_by)
             VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_entra_id, role, scope_id) DO NOTHING
           RETURNING user_entra_id, role, scope_id, granted_at, granted_by`,
          [target, role, scope_id, callerId],
        );
        return rows[0] ?? null;
      });

      if (inserted) {
        await appendAudit(pool, {
          actor: callerId,
          action: "admin_role.grant",
          target,
          afterValue: { role, scope_id },
          reason,
        });
      }

      return await reply.send({
        granted: inserted !== null,
        user_entra_id: target,
        role,
        scope_id,
      });
    },
  );

  // DELETE /api/admin/users/:entra_id/admin-role?role=…&scope_id=… — revoke a role.
  app.delete(
    "/api/admin/users/:entra_id/admin-role",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const callerId = getUserEntraId(req);
      if (!(await guardAdmin(pool, callerId, reply))) return;

      const { entra_id } = req.params as { entra_id: string };
      const parsed = RevokeQuery.safeParse(req.query);
      if (!parsed.success) {
        return await reply.status(400).send({
          error: "Invalid query.",
          issues: parsed.error.issues,
        });
      }
      const { role, scope_id } = parsed.data;
      const target = entra_id.toLowerCase();

      const before = await withUserContext(pool, callerId, async (client) => {
        const { rows } = await client.query<AdminRoleRow>(
          `DELETE FROM admin_roles
            WHERE user_entra_id = $1 AND role = $2 AND scope_id = $3
          RETURNING user_entra_id, role, scope_id, granted_at, granted_by`,
          [target, role, scope_id],
        );
        return rows[0] ?? null;
      });

      if (before) {
        await appendAudit(pool, {
          actor: callerId,
          action: "admin_role.revoke",
          target,
          beforeValue: { role, scope_id, granted_by: before.granted_by },
        });
      }

      return await reply.send({
        revoked: before !== null,
        user_entra_id: target,
        role,
        scope_id,
      });
    },
  );
}
