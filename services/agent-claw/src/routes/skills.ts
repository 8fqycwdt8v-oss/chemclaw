// GET  /api/skills/list    — returns all loaded skill packs with active flag.
// POST /api/skills/enable  — { id: string } — enable a skill.
// POST /api/skills/disable — { id: string } — disable a skill.
//
// All three endpoints require authentication. Enable/disable also require
// admin role membership — these mutate process-global state (the active
// skill set, which influences every subsequent /api/chat turn) so a
// regular user must not be able to flip a different user's skill packs.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { SkillLoader } from "../core/skills.js";
import { isAdmin } from "../middleware/require-admin.js";
import { appendAudit } from "./admin/audit-log.js";

export interface SkillsRouteDeps {
  loader: SkillLoader;
  pool: Pool;
  getUser: (req: FastifyRequest) => string;
}

const EnableDisableSchema = z.object({ id: z.string().min(1) });

export function registerSkillsRoutes(app: FastifyInstance, deps: SkillsRouteDeps): void {
  // GET /api/skills/list — auth-gated (read-only, available to any authenticated user).
  app.get("/api/skills/list", async (req, reply) => {
    // getUser throws MissingUserError → 401 in production if no x-user-entra-id.
    deps.getUser(req);
    const skills = deps.loader.list().map((s) => ({
      id: s.id,
      description: s.description,
      version: s.version,
      tools: s.tools,
      max_steps_override: s.max_steps_override,
      active: s.active,
    }));
    return await reply.send({ skills });
  });

  // POST /api/skills/enable — admin-only (mutates process-global state).
  app.post("/api/skills/enable", async (req, reply) => {
    const user = deps.getUser(req);
    if (!(await isAdmin(deps.pool, user))) {
      return await reply.code(403).send({
        error: "forbidden",
        detail: "skill enable/disable requires admin role",
      });
    }
    const parsed = EnableDisableSchema.safeParse(req.body);
    if (!parsed.success) {
      return await reply.code(400).send({ error: "invalid_input", detail: parsed.error.issues });
    }
    // Phase 2 of the configuration concept: ensure the activeCap snapshot is
    // fresh from config_settings(key='agent.max_active_skills') before
    // checking it. TTL-cached so this is a no-op the second time within 60s.
    await deps.loader.refreshLimits();
    const wasActive = deps.loader.activeIds.has(parsed.data.id);
    const result = deps.loader.enable(parsed.data.id);
    if (!result.ok) {
      return await reply.code(400).send({ error: result.reason });
    }
    await appendAudit(deps.pool, {
      actor: user,
      action: "skill.enable",
      target: parsed.data.id,
      beforeValue: { active: wasActive },
      afterValue: { active: true },
    });
    return await reply.send({ ok: true, active: [...deps.loader.activeIds] });
  });

  // POST /api/skills/disable — admin-only.
  app.post("/api/skills/disable", async (req, reply) => {
    const user = deps.getUser(req);
    if (!(await isAdmin(deps.pool, user))) {
      return await reply.code(403).send({
        error: "forbidden",
        detail: "skill enable/disable requires admin role",
      });
    }
    const parsed = EnableDisableSchema.safeParse(req.body);
    if (!parsed.success) {
      return await reply.code(400).send({ error: "invalid_input", detail: parsed.error.issues });
    }
    const wasActive = deps.loader.activeIds.has(parsed.data.id);
    const result = deps.loader.disable(parsed.data.id);
    if (!result.ok) {
      return await reply.code(400).send({ error: result.reason });
    }
    await appendAudit(deps.pool, {
      actor: user,
      action: "skill.disable",
      target: parsed.data.id,
      beforeValue: { active: wasActive },
      afterValue: { active: false },
    });
    return await reply.send({ ok: true, active: [...deps.loader.activeIds] });
  });
}
