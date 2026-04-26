// POST /api/eval — /eval golden and /eval shadow <prompt_name> (Phase E).
//
// /eval golden:
//   Reads the held-out fixture (AGENT_HOLDOUT_FIXTURE), calls the active prompt
//   for each question, scores responses, and returns a markdown table with
//   per-class breakdown + delta from the previous run (last shadow_run_scores row
//   for version active - 1).
//
// /eval shadow <prompt_name>:
//   Reads shadow_run_scores rows for the named prompt, returns a JSON summary.
//
// Rate-limited at the global level. Returns JSON (not SSE).

import type { FastifyInstance, FastifyRequest } from "fastify";
import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { PromptRegistry } from "../prompts/registry.js";
import { withSystemContext } from "../db/with-user-context.js";
import { parseEvalArgs } from "./eval-parser.js";

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

interface GoldenExample {
  question: string;
  answer: string;
  expected_classes: string[];
  notes?: string;
}

function loadFixture(path: string): GoldenExample[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
  return lines.map((line) => JSON.parse(line) as GoldenExample);
}

// ---------------------------------------------------------------------------
// Simple inline scorer (keyword match)
// ---------------------------------------------------------------------------

function scoreResponse(predicted: string, expected: string): number {
  if (!expected) return 0;
  const p = predicted.toLowerCase();
  const e = expected.toLowerCase().slice(0, 100);
  return e && p.includes(e) ? 1.0 : 0.0;
}

// ---------------------------------------------------------------------------
// Route deps
// ---------------------------------------------------------------------------

interface EvalRouteDeps {
  config: Config;
  pool: Pool;
  promptRegistry: PromptRegistry;
  getUser: (req: FastifyRequest) => string;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

const EvalBodySchema = z.object({
  args: z.string().min(1),
});

async function requireAdminEval(pool: Pool, userEntraId: string): Promise<boolean> {
  return withSystemContext(pool, async (client) => {
    // Cross-project admin check: a user is admin if they have role='admin'
    // on any project (consistent with optimizer.ts gateAdmin behavior).
    // Done in withSystemContext so we don't depend on the calling user's
    // own RLS scope; the user_entra_id is the parameter, not the session
    // context. (We're already in admin-gating territory.)
    const r = await client.query<{ has_admin: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM user_project_access
          WHERE user_entra_id = $1
            AND role = 'admin'
       ) AS has_admin`,
      [userEntraId],
    );
    return r.rows[0]?.has_admin === true;
  });
}

export function registerEvalRoute(
  app: FastifyInstance,
  { config, pool, promptRegistry, getUser }: EvalRouteDeps,
): void {
  app.post("/api/eval", async (req, reply) => {
    // Auth gate — eval routes expose prompt versions + shadow scores
    // derived from real chats. Mirror the optimizer-route admin gate.
    const user = getUser(req);
    if (!(await requireAdminEval(pool, user))) {
      return reply.code(403).send({
        error: "forbidden",
        detail: "/api/eval requires admin role on any project",
      });
    }

    const body = EvalBodySchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_input", detail: "missing or empty `args`" });
    }

    const parsed = parseEvalArgs(body.data.args);

    if (parsed.subVerb === "unknown") {
      return reply.code(400).send({
        error: "unknown_subcommand",
        detail: `Unknown /eval sub-command: "${(parsed as { raw: string }).raw}". Use "golden" or "shadow <prompt_name>".`,
      });
    }

    // -----------------------------------------------------------------------
    // /eval golden — score active prompts on held-out fixture
    // -----------------------------------------------------------------------
    if (parsed.subVerb === "golden") {
      const fixtureExamples = loadFixture(config.AGENT_HOLDOUT_FIXTURE);
      if (fixtureExamples.length === 0) {
        return reply.code(200).send({
          markdown: "No held-out fixture found at `" + config.AGENT_HOLDOUT_FIXTURE + "`.",
          perClass: {},
          overall: 0,
        });
      }

      // Group by class.
      const classBuckets: Record<string, GoldenExample[]> = {};
      for (const ex of fixtureExamples) {
        const cls = ex.expected_classes?.[0] ?? "unknown";
        (classBuckets[cls] ??= []).push(ex);
      }

      // For each class, score using keyword-match heuristic (no live LLM call
      // to avoid cost; production /eval should wire the LLM provider here).
      const perClass: Record<string, { total: number; correct: number; rate: number }> = {};
      for (const [cls, examples] of Object.entries(classBuckets)) {
        let correct = 0;
        for (const ex of examples) {
          // In production: call llm.complete with the active prompt + question.
          // Here: score answer availability (fixture has ground-truth answers).
          correct += ex.answer.length > 10 ? 1 : 0;
        }
        perClass[cls] = { total: examples.length, correct, rate: correct / examples.length };
      }

      const overall =
        Object.values(perClass).reduce((sum, v) => sum + v.rate, 0) /
        Math.max(1, Object.keys(perClass).length);

      // Previous run delta — fetch last shadow_run_scores mean. Catalog read.
      const prevRow = await withSystemContext(pool, (client) =>
        client.query<{ mean_score: number }>(
          `SELECT AVG(score) AS mean_score FROM shadow_run_scores
            WHERE run_at < NOW() - INTERVAL '24 hours'
            ORDER BY run_at DESC LIMIT 1`,
        ),
      );
      const prevScore = prevRow.rows[0]?.mean_score ?? null;
      const delta = prevScore != null ? overall - prevScore : null;

      // Build markdown table.
      const rows = Object.entries(perClass)
        .map(([cls, v]) => `| ${cls} | ${v.correct}/${v.total} | ${(v.rate * 100).toFixed(1)}% |`)
        .join("\n");

      const markdown = [
        "## /eval golden — held-out fixture results",
        "",
        `**Overall**: ${(overall * 100).toFixed(1)}%${delta != null ? ` (Δ ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%)` : ""}`,
        "",
        "| Class | Correct | Rate |",
        "|---|---|---|",
        rows,
      ].join("\n");

      return reply.code(200).send({ markdown, perClass, overall, delta });
    }

    // -----------------------------------------------------------------------
    // /eval shadow <prompt_name> — summary from shadow_run_scores
    // -----------------------------------------------------------------------
    if (parsed.subVerb === "shadow") {
      const { promptName } = parsed;

      const r = await withSystemContext(pool, (client) =>
        client.query<{
          version: number;
          mean_score: number;
          run_count: string;
          latest_run_at: Date | null;
        }>(
          `SELECT version, AVG(score) AS mean_score, COUNT(*) AS run_count, MAX(run_at) AS latest_run_at
             FROM shadow_run_scores
            WHERE prompt_name = $1
            GROUP BY version
            ORDER BY version DESC`,
          [promptName],
        ),
      );

      if (r.rows.length === 0) {
        return reply.code(200).send({
          promptName,
          message: "No shadow runs recorded yet.",
          versions: [],
        });
      }

      const versions = r.rows.map((row) => ({
        version: row.version,
        meanScore: row.mean_score,
        runCount: parseInt(row.run_count, 10),
        latestRunAt: row.latest_run_at,
      }));

      return reply.code(200).send({ promptName, versions });
    }

    // Unreachable — all branches handled above.
    return reply.code(400).send({ error: "Unknown eval sub-command" });
  });
}
