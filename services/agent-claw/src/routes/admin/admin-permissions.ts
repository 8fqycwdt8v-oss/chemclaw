// Phase 3 of the configuration concept (Initiative 5).
//
// /api/admin/permission-policies — list / add / disable / delete.
// Mutations bust the in-process PermissionPolicyLoader cache so the next
// pre_tool dispatch sees the change immediately.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import { withUserContext } from "../../db/with-user-context.js";
import { isAdmin, guardAdmin } from "../../middleware/require-admin.js";
import { appendAudit } from "./audit-log.js";
import { getPermissionPolicyLoader } from "../../core/permissions/policy-loader.js";

const SCOPE_VALUES = ["global", "org", "project"] as const;
const DECISION_VALUES = ["allow", "deny", "ask"] as const;

const CreateBody = z.object({
  scope: z.enum(SCOPE_VALUES),
  scope_id: z.string().max(200).default(""),
  decision: z.enum(DECISION_VALUES),
  tool_pattern: z.string().min(1).max(200),
  argument_pattern: z.string().max(200).optional(),
  reason: z.string().max(500).optional(),
  audit_reason: z.string().min(1).max(500).optional(),
});

const ToggleBody = z.object({
  enabled: z.boolean(),
  audit_reason: z.string().min(1).max(500).optional(),
});

interface PolicyRow {
  id: string;
  scope: string;
  scope_id: string;
  decision: string;
  tool_pattern: string;
  argument_pattern: string | null;
  reason: string | null;
  enabled: boolean;
  created_at: string;
  created_by: string;
}

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

export function registerAdminPermissionRoutes(
  app: FastifyInstance,
  pool: Pool,
  getUserEntraId: (req: FastifyRequest) => string,
): void {

  app.get("/api/admin/permission-policies", async (req: FastifyRequest, reply: FastifyReply) => {
    const callerId = getUserEntraId(req);
    if (!(await guardAdmin(pool, callerId, reply))) return;
    const rows = await withUserContext(pool, callerId, async (client) => {
      const { rows } = await client.query<PolicyRow>(
        `SELECT id::text, scope, scope_id, decision, tool_pattern,
                argument_pattern, reason, enabled, created_at, created_by
           FROM permission_policies
          ORDER BY scope, scope_id, decision, tool_pattern`,
      );
      return rows;
    });
    return await reply.send({ policies: rows, count: rows.length });
  });

  app.post("/api/admin/permission-policies", async (req: FastifyRequest, reply: FastifyReply) => {
    const callerId = getUserEntraId(req);
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      return await reply.status(400).send({ error: "Invalid body.", issues: parsed.error.issues });
    }
    const { scope, scope_id, decision, tool_pattern, argument_pattern, reason, audit_reason } = parsed.data;

    if (scope === "global" && scope_id !== "") {
      return await reply.status(400).send({ error: "global scope must have empty scope_id." });
    }
    if (scope !== "global" && scope_id === "") {
      return await reply.status(400).send({ error: `${scope} requires non-empty scope_id.` });
    }

    if (!(await adminAllowedForScope(pool, callerId, scope, scope_id))) {
      return await reply.status(403).send({
        error: `Permission denied. Requires global_admin or ${scope}_admin on '${scope_id}'.`,
      });
    }

    if (argument_pattern) {
      try {
        new RegExp(argument_pattern);
      } catch (e) {
        return await reply.status(400).send({ error: `Invalid argument_pattern regex: ${(e as Error).message}` });
      }
    }

    let inserted: PolicyRow | null = null;
    let conflict = false;
    try {
      inserted = await withUserContext(pool, callerId, async (client) => {
        const { rows } = await client.query<PolicyRow>(
          `INSERT INTO permission_policies
             (scope, scope_id, decision, tool_pattern, argument_pattern,
              reason, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id::text, scope, scope_id, decision, tool_pattern,
                     argument_pattern, reason, enabled, created_at, created_by`,
          [scope, scope_id, decision, tool_pattern, argument_pattern ?? null, reason ?? null, callerId],
        );
        return rows[0] ?? null;
      });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") conflict = true;
      else throw err;
    }
    if (conflict) {
      return await reply.status(409).send({ error: "An identical policy already exists." });
    }
    if (!inserted) {
      // Belt and suspenders: RETURNING on a successful INSERT must yield 1 row.
      return await reply.status(500).send({ error: "Insert returned no row." });
    }

    await appendAudit(pool, {
      actor: callerId,
      action: "permission_policy.create",
      target: inserted.id,
      afterValue: inserted,
      reason: audit_reason,
    });

    try { getPermissionPolicyLoader()?.invalidate(); } catch { /* singleton not init in tests */ }

    return await reply.send({ ok: true, policy: inserted });
  });

  app.patch(
    "/api/admin/permission-policies/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const callerId = getUserEntraId(req);
      const { id } = req.params as { id: string };

      // Read scope first to know which admin role to require.
      const existing = await withUserContext(pool, callerId, async (client) => {
        const { rows } = await client.query<{ scope: string; scope_id: string; enabled: boolean }>(
          `SELECT scope, scope_id, enabled FROM permission_policies WHERE id = $1::uuid`,
          [id],
        );
        return rows[0] ?? null;
      });
      if (!existing) {
        return await reply.status(404).send({ error: "Policy not found." });
      }
      if (!(await adminAllowedForScope(pool, callerId, existing.scope, existing.scope_id))) {
        return await reply.status(403).send({
          error: `Permission denied. Requires global_admin or ${existing.scope}_admin on '${existing.scope_id}'.`,
        });
      }

      const parsed = ToggleBody.safeParse(req.body);
      if (!parsed.success) {
        return await reply.status(400).send({ error: "Invalid body.", issues: parsed.error.issues });
      }
      const { enabled, audit_reason } = parsed.data;

      await withUserContext(pool, callerId, async (client) => {
        await client.query(
          `UPDATE permission_policies SET enabled = $1 WHERE id = $2::uuid`,
          [enabled, id],
        );
      });

      await appendAudit(pool, {
        actor: callerId,
        action: enabled ? "permission_policy.enable" : "permission_policy.disable",
        target: id,
        beforeValue: { enabled: existing.enabled },
        afterValue: { enabled },
        reason: audit_reason,
      });

      try { getPermissionPolicyLoader()?.invalidate(); } catch { /* singleton not init in tests */ }

      return await reply.send({ ok: true, id, enabled });
    },
  );

  app.delete(
    "/api/admin/permission-policies/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const callerId = getUserEntraId(req);
      const { id } = req.params as { id: string };
      const existing = await withUserContext(pool, callerId, async (client) => {
        const { rows } = await client.query<PolicyRow>(
          `SELECT id::text, scope, scope_id, decision, tool_pattern,
                  argument_pattern, reason, enabled, created_at, created_by
             FROM permission_policies WHERE id = $1::uuid`,
          [id],
        );
        return rows[0] ?? null;
      });
      if (!existing) {
        return await reply.status(404).send({ error: "Policy not found." });
      }
      if (!(await adminAllowedForScope(pool, callerId, existing.scope, existing.scope_id))) {
        return await reply.status(403).send({
          error: `Permission denied. Requires global_admin or ${existing.scope}_admin on '${existing.scope_id}'.`,
        });
      }

      await withUserContext(pool, callerId, async (client) => {
        await client.query(`DELETE FROM permission_policies WHERE id = $1::uuid`, [id]);
      });

      await appendAudit(pool, {
        actor: callerId,
        action: "permission_policy.delete",
        target: id,
        beforeValue: existing,
      });

      try { getPermissionPolicyLoader()?.invalidate(); } catch { /* singleton not init in tests */ }

      return await reply.send({ deleted: true, id });
    },
  );
}
