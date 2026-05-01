// Phase 3 of the configuration concept (Initiative 4).
//
// /api/admin/redaction-patterns — list / add / disable / delete.
// All endpoints require global_admin (org-scoped patterns also require
// global_admin in this PR because there is no admin UI yet to delegate
// per-org pattern management; can be relaxed later).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import { withUserContext } from "../../db/with-user-context.js";
import { guardAdmin } from "../../middleware/require-admin.js";
import { appendAudit } from "./audit-log.js";

const CATEGORY_VALUES = [
  "SMILES", "RXN_SMILES", "EMAIL", "NCE",
  "CMP", "COMPOUND_CODE", "PROJECT_ID", "CUSTOM",
] as const;

const CreateBody = z.object({
  scope: z.enum(["global", "org"]),
  scope_id: z.string().max(200).default(""),
  category: z.enum(CATEGORY_VALUES),
  pattern_regex: z.string().min(1).max(200),
  flags_re_i: z.boolean().default(false),
  description: z.string().max(500).optional(),
  reason: z.string().min(1).max(500).optional(),
});

const ToggleBody = z.object({
  enabled: z.boolean(),
  reason: z.string().min(1).max(500).optional(),
});

interface PatternRow {
  id: string;
  scope: string;
  scope_id: string;
  category: string;
  pattern_regex: string;
  flags_re_i: boolean;
  enabled: boolean;
  description: string | null;
  created_at: string;
  created_by: string;
}

/**
 * Server-side regex safety check, mirroring services/litellm_redactor/
 * dynamic_patterns.py:is_pattern_safe. The DB CHECK already bounds length;
 * this catches unbounded quantifiers that would slip past the length cap.
 */
function isPatternSafe(raw: string): { ok: boolean; reason?: string } {
  if (raw.length > 200) return { ok: false, reason: "pattern length > 200" };
  const unbounded = /(?<!\\)(?:\.\*|\.\+|\\S\+|\\w\+|\\d\+|\\D\+|\\W\+)(?!\?\{)/;
  if (unbounded.test(raw)) {
    return { ok: false, reason: "unbounded quantifier (use bounded {n,m} form)" };
  }
  try {
    new RegExp(raw);
  } catch (e) {
    return { ok: false, reason: `invalid regex: ${(e as Error).message}` };
  }
  return { ok: true };
}

export function registerAdminRedactionRoutes(
  app: FastifyInstance,
  pool: Pool,
  getUserEntraId: (req: FastifyRequest) => string,
): void {

  app.get("/api/admin/redaction-patterns", async (req: FastifyRequest, reply: FastifyReply) => {
    const callerId = getUserEntraId(req);
    if (!(await guardAdmin(pool, callerId, reply))) return;
    const rows = await withUserContext(pool, callerId, async (client) => {
      const { rows } = await client.query<PatternRow>(
        `SELECT id::text, scope, scope_id, category, pattern_regex,
                flags_re_i, enabled, description, created_at, created_by
           FROM redaction_patterns
          ORDER BY scope, scope_id, category, created_at`,
      );
      return rows;
    });
    return await reply.send({ patterns: rows, count: rows.length });
  });

  app.post("/api/admin/redaction-patterns", async (req: FastifyRequest, reply: FastifyReply) => {
    const callerId = getUserEntraId(req);
    if (!(await guardAdmin(pool, callerId, reply))) return;

    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      return await reply.status(400).send({ error: "Invalid body.", issues: parsed.error.issues });
    }
    const { scope, scope_id, category, pattern_regex, flags_re_i, description, reason } = parsed.data;

    if (scope === "global" && scope_id !== "") {
      return await reply.status(400).send({ error: "global scope must have empty scope_id." });
    }
    if (scope === "org" && scope_id === "") {
      return await reply.status(400).send({ error: "org scope requires non-empty scope_id." });
    }

    const safety = isPatternSafe(pattern_regex);
    if (!safety.ok) {
      return await reply.status(400).send({ error: `Unsafe pattern: ${safety.reason ?? "unknown"}.` });
    }

    const inserted = await withUserContext(pool, callerId, async (client) => {
      const { rows } = await client.query<PatternRow>(
        `INSERT INTO redaction_patterns
           (scope, scope_id, category, pattern_regex, flags_re_i,
            description, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id::text, scope, scope_id, category, pattern_regex,
                   flags_re_i, enabled, description, created_at, created_by`,
        [scope, scope_id, category, pattern_regex, flags_re_i, description ?? null, callerId],
      );
      return rows[0] ?? null;
    });
    if (!inserted) {
      return await reply.status(500).send({ error: "Insert returned no row." });
    }

    await appendAudit(pool, {
      actor: callerId,
      action: "redaction_pattern.create",
      target: inserted.id,
      afterValue: inserted,
      reason,
    });

    return await reply.send({ ok: true, pattern: inserted });
  });

  app.patch(
    "/api/admin/redaction-patterns/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const callerId = getUserEntraId(req);
      if (!(await guardAdmin(pool, callerId, reply))) return;
      const { id } = req.params as { id: string };
      const parsed = ToggleBody.safeParse(req.body);
      if (!parsed.success) {
        return await reply.status(400).send({ error: "Invalid body.", issues: parsed.error.issues });
      }
      const { enabled, reason } = parsed.data;

      const result = await withUserContext(pool, callerId, async (client) => {
        const { rows } = await client.query<{ enabled: boolean }>(
          `UPDATE redaction_patterns SET enabled = $1
            WHERE id = $2::uuid
          RETURNING enabled`,
          [enabled, id],
        );
        return rows[0] ?? null;
      });
      if (!result) {
        return await reply.status(404).send({ error: "Pattern not found." });
      }

      await appendAudit(pool, {
        actor: callerId,
        action: enabled ? "redaction_pattern.enable" : "redaction_pattern.disable",
        target: id,
        afterValue: { enabled },
        reason,
      });

      return await reply.send({ ok: true, id, enabled });
    },
  );

  app.delete(
    "/api/admin/redaction-patterns/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const callerId = getUserEntraId(req);
      if (!(await guardAdmin(pool, callerId, reply))) return;
      const { id } = req.params as { id: string };
      const before = await withUserContext(pool, callerId, async (client) => {
        const { rows } = await client.query<PatternRow>(
          `DELETE FROM redaction_patterns WHERE id = $1::uuid
           RETURNING id::text, scope, scope_id, category, pattern_regex,
                     flags_re_i, enabled, description, created_at, created_by`,
          [id],
        );
        return rows[0] ?? null;
      });
      if (before) {
        await appendAudit(pool, {
          actor: callerId,
          action: "redaction_pattern.delete",
          target: id,
          beforeValue: before,
        });
      }
      return await reply.send({ deleted: before !== null, id });
    },
  );
}
