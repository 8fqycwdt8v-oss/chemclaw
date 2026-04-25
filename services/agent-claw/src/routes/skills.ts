// GET /api/skills/list — returns all loaded skill packs with active flag.
// POST /api/skills/enable  — { id: string } — enable a skill.
// POST /api/skills/disable — { id: string } — disable a skill.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SkillLoader } from "../core/skills.js";

export interface SkillsRouteDeps {
  loader: SkillLoader;
}

const EnableDisableSchema = z.object({ id: z.string().min(1) });

export function registerSkillsRoutes(app: FastifyInstance, deps: SkillsRouteDeps): void {
  // GET /api/skills/list
  app.get("/api/skills/list", async (_req, reply) => {
    const skills = deps.loader.list().map((s) => ({
      id: s.id,
      description: s.description,
      version: s.version,
      tools: s.tools,
      max_steps_override: s.max_steps_override,
      active: s.active,
    }));
    return reply.send({ skills });
  });

  // POST /api/skills/enable
  app.post("/api/skills/enable", async (req, reply) => {
    const parsed = EnableDisableSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", detail: parsed.error.issues });
    }
    const result = deps.loader.enable(parsed.data.id);
    if (!result.ok) {
      return reply.code(400).send({ error: result.reason });
    }
    return reply.send({ ok: true, active: [...deps.loader.activeIds] });
  });

  // POST /api/skills/disable
  app.post("/api/skills/disable", async (req, reply) => {
    const parsed = EnableDisableSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", detail: parsed.error.issues });
    }
    const result = deps.loader.disable(parsed.data.id);
    if (!result.ok) {
      return reply.code(400).send({ error: result.reason });
    }
    return reply.send({ ok: true, active: [...deps.loader.activeIds] });
  });
}
