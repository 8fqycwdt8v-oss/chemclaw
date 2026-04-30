// Phase 1 of the configuration concept (Initiative 10).
//
// GET /api/admin/audit — paginated read of admin_audit_log with optional
// filters by actor, action, target. Admin-gated; uses the standard pool +
// withUserContext, relying on the admin_audit_log_admin_select RLS policy
// to gate visibility (current_user_is_admin()).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import { withUserContext } from "../../db/with-user-context.js";
import { guardAdmin } from "../../middleware/require-admin.js";

const Query = z.object({
  actor: z.string().max(200).optional(),
  action: z.string().max(200).optional(),
  target: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.string().datetime({ offset: true }).optional(),
});

interface AuditRow {
  id: string;
  occurred_at: string;
  actor: string;
  action: string;
  target: string;
  before_value: unknown;
  after_value: unknown;
  reason: string | null;
}

export function registerAdminAuditRoute(
  app: FastifyInstance,
  pool: Pool,
  getUserEntraId: (req: FastifyRequest) => string,
): void {
  app.get("/api/admin/audit", async (req: FastifyRequest, reply: FastifyReply) => {
    const callerId = getUserEntraId(req);
    if (!(await guardAdmin(pool, callerId, reply))) return;

    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      return await reply.status(400).send({
        error: "Invalid query.",
        issues: parsed.error.issues,
      });
    }
    const { actor, action, target, limit, before } = parsed.data;

    const rows = await withUserContext(pool, callerId, async (client) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      const push = (clause: string, value: unknown) => {
        params.push(value);
        conditions.push(clause.replace("$?", `$${params.length}`));
      };
      if (actor)  push("actor  = $?", actor);
      if (action) push("action = $?", action);
      if (target) push("target = $?", target);
      if (before) push("occurred_at < $?", before);

      params.push(limit);
      const limitParam = `$${params.length}`;
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const { rows } = await client.query<AuditRow>(
        `SELECT id::text, occurred_at, actor, action, target,
                before_value, after_value, reason
           FROM admin_audit_log
           ${where}
          ORDER BY occurred_at DESC
          LIMIT ${limitParam}`,
        params,
      );
      return rows;
    });

    return await reply.send({ entries: rows, count: rows.length });
  });
}
