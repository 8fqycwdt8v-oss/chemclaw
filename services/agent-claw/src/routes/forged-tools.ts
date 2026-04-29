// POST /api/forged-tools/:id/scope   — promote to project|org (admin-gated)
// POST /api/forged-tools/:id/disable  — disable a forged tool (owner-or-admin)
// GET  /api/forged-tools              — list forged tools visible to the caller
// GET  /api/forged-tools/:id/code     — return tool Python source
// GET  /api/forged-tools/:id/tests    — return persistent test cases
//
// Admin gate: env var AGENT_ADMIN_USERS (comma-separated Entra IDs / emails).
// Phase F will replace with proper RBAC.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import { withUserContext } from "../db/with-user-context.js";
import { promises as fsp } from "fs";

// ---------------------------------------------------------------------------
// Admin check
// ---------------------------------------------------------------------------

function isAdmin(userEntraId: string): boolean {
  const raw = process.env.AGENT_ADMIN_USERS ?? "";
  if (!raw.trim()) return false;
  const admins = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(userEntraId.toLowerCase());
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ScopeBody = z.object({
  scope: z.enum(["project", "org"]),
});

const DisableBody = z.object({
  reason: z.string().min(1).max(500),
});

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

interface ForgedToolRow {
  id: string;
  name: string;
  scope: string;
  active: boolean;
  version: number;
  forged_by_model: string | null;
  forged_by_role: string | null;
  proposed_by_user_entra_id: string;
  scripts_path: string | null;
  created_at: string;
  shadow_until: string | null;
  // joined from validation_runs
  last_status: string | null;
  pass_rate: number | null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerForgedToolsRoutes(
  app: FastifyInstance,
  pool: Pool,
  getUserEntraId: (req: FastifyRequest) => string,
): Promise<void> {

  // GET /api/forged-tools — list all forged tools visible via RLS.
  app.get("/api/forged-tools", async (req: FastifyRequest, reply: FastifyReply) => {
    const userEntraId = getUserEntraId(req);
    const rows = await withUserContext(pool, userEntraId, async (client) => {
      const { rows } = await client.query<ForgedToolRow>(`
        SELECT
          sl.id::text,
          sl.name,
          sl.scope,
          sl.active,
          sl.version,
          sl.forged_by_model,
          sl.forged_by_role,
          sl.proposed_by_user_entra_id,
          sl.scripts_path,
          sl.created_at,
          sl.shadow_until,
          vr.status AS last_status,
          CASE WHEN vr.total_tests > 0
               THEN vr.passed::numeric / vr.total_tests
               ELSE NULL END AS pass_rate
        FROM skill_library sl
        LEFT JOIN LATERAL (
          SELECT status, total_tests, passed
          FROM forged_tool_validation_runs
          WHERE forged_tool_id = sl.id
          ORDER BY run_at DESC LIMIT 1
        ) vr ON true
        WHERE sl.kind = 'forged_tool'
        ORDER BY sl.created_at DESC
      `);
      return rows;
    });
    return reply.send({ tools: rows });
  });

  // GET /api/forged-tools/:id/code — return the Python source code.
  app.get("/api/forged-tools/:id/code", async (req: FastifyRequest, reply: FastifyReply) => {
    const userEntraId = getUserEntraId(req);
    const { id } = req.params as { id: string };

    const row = await withUserContext(pool, userEntraId, async (client) => {
      const { rows } = await client.query<{ scripts_path: string | null; name: string }>(
        `SELECT scripts_path, name FROM skill_library
         WHERE id = $1::uuid AND kind = 'forged_tool'`,
        [id],
      );
      return rows[0] ?? null;
    });

    if (!row) {
      return reply.status(404).send({ error: "Forged tool not found." });
    }
    if (!row.scripts_path) {
      return reply.status(404).send({ error: "No script path recorded for this tool." });
    }

    let code: string;
    try {
      code = await fsp.readFile(row.scripts_path, "utf-8");
    } catch {
      return reply.status(404).send({ error: "Script file not found on disk." });
    }

    return reply.send({ name: row.name, code });
  });

  // GET /api/forged-tools/:id/tests — return persistent test cases.
  app.get("/api/forged-tools/:id/tests", async (req: FastifyRequest, reply: FastifyReply) => {
    const userEntraId = getUserEntraId(req);
    const { id } = req.params as { id: string };

    const tests = await withUserContext(pool, userEntraId, async (client) => {
      // Verify tool visibility first.
      const { rows: toolRows } = await client.query(
        `SELECT id FROM skill_library WHERE id = $1::uuid AND kind = 'forged_tool'`,
        [id],
      );
      if (toolRows.length === 0) return null;

      const { rows } = await client.query(
        `SELECT id::text, forged_tool_id::text, input_json, expected_output_json,
                tolerance_json, kind, created_at
         FROM forged_tool_tests
         WHERE forged_tool_id = $1::uuid
         ORDER BY created_at ASC`,
        [id],
      );
      return rows;
    });

    if (tests === null) {
      return reply.status(404).send({ error: "Forged tool not found." });
    }

    return reply.send({ tests });
  });

  // POST /api/forged-tools/:id/scope — promote to project|org.
  app.post("/api/forged-tools/:id/scope", async (req: FastifyRequest, reply: FastifyReply) => {
    const userEntraId = getUserEntraId(req);
    const { id } = req.params as { id: string };

    const bodyParsed = ScopeBody.safeParse(req.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({
        error: "Invalid body.",
        issues: bodyParsed.error.issues,
      });
    }
    const { scope } = bodyParsed.data;

    // Owner OR admin.
    const row = await withUserContext(pool, userEntraId, async (client) => {
      const { rows } = await client.query<{ proposed_by_user_entra_id: string }>(
        `SELECT proposed_by_user_entra_id FROM skill_library
         WHERE id = $1::uuid AND kind = 'forged_tool'`,
        [id],
      );
      return rows[0] ?? null;
    });

    if (!row) {
      return reply.status(404).send({ error: "Forged tool not found." });
    }

    const isOwner = row.proposed_by_user_entra_id === userEntraId;
    if (!isOwner && !isAdmin(userEntraId)) {
      return reply
        .status(403)
        .send({ error: "Permission denied. Only the tool owner or an admin can promote scope." });
    }

    await withUserContext(pool, userEntraId, async (client) => {
      await client.query(
        `UPDATE skill_library
           SET scope = $1, scope_promoted_at = NOW(), scope_promoted_by = $2
         WHERE id = $3::uuid`,
        [scope, userEntraId, id],
      );
    });

    return reply.send({ ok: true, scope });
  });

  // POST /api/forged-tools/:id/disable — set active=false.
  app.post("/api/forged-tools/:id/disable", async (req: FastifyRequest, reply: FastifyReply) => {
    const userEntraId = getUserEntraId(req);
    const { id } = req.params as { id: string };

    const bodyParsed = DisableBody.safeParse(req.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({
        error: "Invalid body. Provide { reason: string }.",
        issues: bodyParsed.error.issues,
      });
    }

    const row = await withUserContext(pool, userEntraId, async (client) => {
      const { rows } = await client.query<{ proposed_by_user_entra_id: string }>(
        `SELECT proposed_by_user_entra_id FROM skill_library
         WHERE id = $1::uuid AND kind = 'forged_tool'`,
        [id],
      );
      return rows[0] ?? null;
    });

    if (!row) {
      return reply.status(404).send({ error: "Forged tool not found." });
    }

    const isOwner = row.proposed_by_user_entra_id === userEntraId;
    if (!isOwner && !isAdmin(userEntraId)) {
      return reply
        .status(403)
        .send({ error: "Permission denied. Only the tool owner or an admin can disable." });
    }

    await withUserContext(pool, userEntraId, async (client) => {
      await client.query(
        `UPDATE skill_library SET active = false WHERE id = $1::uuid`,
        [id],
      );
    });

    return reply.send({ ok: true, disabled: true });
  });
}
