// POST /api/feedback — writes a feedback_events row + best-effort Langfuse score.
//
// Request body:
//   { trace_id?: string, signal: 'up'|'down', reason?: string }
//
// Maps:
//   'up'   → signal='thumbs_up'
//   'down' → signal='thumbs_down'
//
// The slash verb /feedback up|down "<reason>" already posts to /api/chat which
// calls writeFeedback inline. This dedicated route allows any non-streaming
// client (the future frontend repo, scripted tooling) to POST directly
// without going through the SSE chat path.
//
// Langfuse score: best-effort via OTLP attribute on the trace span.
// Failure is logged, not surfaced to the caller.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import { withUserContext } from "../db/with-user-context.js";
import type { PromptRegistry } from "../prompts/registry.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeedbackBodySchema = z.object({
  trace_id: z.string().optional(),
  signal: z.enum(["up", "down"]),
  reason: z.string().max(500).optional(),
});

type FeedbackBody = z.infer<typeof FeedbackBodySchema>;

// ---------------------------------------------------------------------------
// DB writer
// ---------------------------------------------------------------------------

async function insertFeedback(
  pool: Pool,
  userEntraId: string,
  body: FeedbackBody,
  promptName: string | null,
  promptVersion: number | null,
): Promise<void> {
  const dbSignal = body.signal === "up" ? "thumbs_up" : "thumbs_down";
  await withUserContext(pool, userEntraId, async (client) => {
    await client.query(
      `INSERT INTO feedback_events
         (user_entra_id, signal, query_text, trace_id,
          prompt_name, prompt_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userEntraId,
        dbSignal,
        body.reason ?? null,
        body.trace_id ?? null,
        promptName,
        promptVersion,
      ],
    );
  });
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface FeedbackRouteDeps {
  pool: Pool;
  getUser: (req: FastifyRequest) => string;
  /** Optional prompt registry — when present, /api/feedback rows carry
   * prompt_name / prompt_version so GEPA can scope them. */
  promptRegistry?: PromptRegistry;
  /** Optional Langfuse host for score reporting. */
  langfuseHost?: string;
  langfusePublicKey?: string;
  langfuseSecretKey?: string;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerFeedbackRoute(
  app: FastifyInstance,
  deps: FeedbackRouteDeps,
): void {
  app.post("/api/feedback", async (req, reply) => {
    const user = deps.getUser(req);
    const parsed = FeedbackBodySchema.safeParse(req.body);

    if (!parsed.success) {
      return await reply.code(400).send({
        error: "invalid_input",
        detail: parsed.error.issues.map((i) => ({ path: i.path, msg: i.message })),
      });
    }

    const body = parsed.data;

    let promptName: string | null = null;
    let promptVersion: number | null = null;
    if (deps.promptRegistry) {
      try {
        const active = await deps.promptRegistry.getActive("agent.system");
        promptName = "agent.system";
        promptVersion = active.version;
      } catch {
        // ignore — leave link columns NULL
      }
    }

    try {
      await insertFeedback(deps.pool, user, body, promptName, promptVersion);
    } catch (err) {
      req.log.error({ err }, "feedback: DB write failed");
      return await reply.code(500).send({ error: "db_write_failed" });
    }

    // Best-effort Langfuse score emission.
    if (deps.langfuseHost && body.trace_id) {
      try {
        await emitLangfuseScore({
          host: deps.langfuseHost,
          publicKey: deps.langfusePublicKey,
          secretKey: deps.langfuseSecretKey,
          traceId: body.trace_id,
          signal: body.signal,
          reason: body.reason,
        });
      } catch (err) {
        req.log.warn({ err }, "feedback: Langfuse score emission failed (non-fatal)");
      }
    }

    return await reply.code(200).send({ status: "ok", signal: body.signal });
  });
}

// ---------------------------------------------------------------------------
// Langfuse score helper (best-effort, non-throwing)
// ---------------------------------------------------------------------------

async function emitLangfuseScore(opts: {
  host: string;
  publicKey?: string;
  secretKey?: string;
  traceId: string;
  signal: "up" | "down";
  reason?: string;
}): Promise<void> {
  const { host, publicKey, secretKey, traceId, signal, reason } = opts;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (publicKey && secretKey) {
    headers.Authorization =
      `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
  }

  const score = signal === "up" ? 1 : 0;

  await fetch(`${host.replace(/\/$/, "")}/api/public/scores`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      traceId,
      name: "user_feedback",
      value: score,
      comment: reason ?? undefined,
      dataType: "NUMERIC",
    }),
    signal: AbortSignal.timeout(5_000),
  });
}
