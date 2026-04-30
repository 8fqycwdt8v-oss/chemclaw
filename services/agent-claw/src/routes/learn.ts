// POST /api/learn — skill induction from the last successful turn.
// Phase C.3: writes a row to skill_library from the last assistant turn.
//
// Request body:
//   {
//     "title": "string — user-provided skill name",
//     "last_turn_text": "string — the last assistant turn to distill",
//     "source_trace_id": "string? — trace_id of the turn"
//   }
//
// Response: { skill_id, name, shadow_until, ok: true }

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import type { LlmProvider } from "../llm/provider.js";
import { withUserContext } from "../db/with-user-context.js";

export interface LearnRouteDeps {
  pool: Pool;
  llm: LlmProvider;
  getUser: (req: FastifyRequest) => string;
}

const LearnRequestSchema = z.object({
  title: z.string().min(1).max(200),
  last_turn_text: z.string().min(10).max(20_000),
  source_trace_id: z.string().optional(),
});

/** Sanitize a user-provided title into a safe skill name. */
function sanitizeName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

export function registerLearnRoute(
  app: FastifyInstance,
  deps: LearnRouteDeps,
): void {
  app.post("/api/learn", async (req, reply) => {
    const parsed = LearnRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return await reply.code(400).send({
        error: "invalid_input",
        detail: parsed.error.issues,
      });
    }

    const user = deps.getUser(req);
    const { title, last_turn_text, source_trace_id } = parsed.data;
    const name = sanitizeName(title);

    if (!name) {
      return await reply.code(400).send({
        error: "invalid_title",
        detail: "Title must contain at least one alphanumeric character.",
      });
    }

    // Distill the skill from the last turn via a structured LLM call.
    const systemPrompt =
      "You are a skill-extraction assistant. Given a successful agent turn transcript, " +
      "extract a reusable skill as a concise markdown document (≤200 words). " +
      "Focus on: the goal, the tool sequence used, any domain-specific heuristics, " +
      "and the format of the final answer. Preserve compound IDs, reaction IDs, " +
      "and fact_ids verbatim. Return JSON: {\"prompt_md\": \"<markdown text>\"}";

    let promptMd: string;
    try {
      const result = (await deps.llm.completeJson({
        system: systemPrompt,
        user: `Skill title: ${title}\n\nTurn transcript:\n\n${last_turn_text}`,
      })) as Record<string, unknown>;

      promptMd =
        typeof result.prompt_md === "string" && result.prompt_md.trim().length > 0
          ? result.prompt_md.trim()
          : `# ${title}\n\n${last_turn_text.slice(0, 600)}`;
    } catch {
      // Fallback: use a truncated version of the turn text.
      promptMd = `# ${title}\n\n${last_turn_text.slice(0, 600)}`;
    }

    // Shadow period: 7 days before Phase E's optimizer can promote.
    const shadowUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    try {
      const result = await withUserContext(deps.pool, user, async (client) => {
        const row = await client.query<{ id: string; name: string }>(
          `INSERT INTO skill_library
             (name, prompt_md, source_trace_id, proposed_by_user_entra_id, shadow_until,
              active, kind)
           VALUES ($1, $2, $3, $4, $5::timestamptz, false, 'prompt')
           RETURNING id::text AS id, name`,
          [name, promptMd, source_trace_id ?? null, user, shadowUntil],
        );
        return row.rows[0] ?? null;
      });

      if (!result) {
        return await reply.code(500).send({ error: "insert_failed" });
      }

      return await reply.send({
        ok: true,
        skill_id: result.id,
        name: result.name,
        shadow_until: shadowUntil,
        message:
          `Skill '${result.name}' saved. It will be eligible for activation ` +
          `after the 7-day shadow period (Phase E promotion).`,
      });
    } catch (err) {
      req.log.error({ err }, "/learn insert failed");
      return await reply.code(500).send({ error: "internal" });
    }
  });
}
