// GET  /api/sessions/:id            — session status endpoint
// GET  /api/sessions                — list calling user's recent sessions
// POST /api/sessions/:id/plan/run   — Phase E: chained-execution of an active plan
// POST /api/sessions/:id/resume     — Phase I: synthetic-continue for the auto-resume cron
// POST /api/internal/sessions/:id/resume — JWT-authenticated reanimator entrypoint
//
// Used by client UIs to render progress (todos), resume affordances
// (awaiting_question), and a session picker. The plan/run + resume
// endpoints are the multi-hour-autonomy unlock — both run a harness turn
// without requiring a fresh user message.
//
// This file is the wiring layer only. The handler bodies live in
// `routes/sessions-handlers.ts`, the chained-harness loop lives in
// `core/chained-harness.ts`. The split happened in PR-6.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PromptRegistry } from "../prompts/registry.js";
import type { PaperclipClient } from "../core/paperclip-client.js";
import {
  handleGetSession,
  handleInternalResume,
  handleListSessions,
  handlePlanRun,
  handleResume,
} from "./sessions-handlers.js";

// Re-exports — preserve the public API the tests + bootstrap import.
export { runChainedHarness } from "../core/chained-harness.js";
export type { ChainedHarnessOptions, ChainedHarnessResult } from "../core/chained-harness.js";

interface SessionsRouteDeps {
  pool: Pool;
  getUser: (req: FastifyRequest) => string;
  // The chained-run + resume endpoints need the harness deps.
  config?: Config;
  llm?: LlmProvider;
  registry?: ToolRegistry;
  promptRegistry?: PromptRegistry;
  /** Paperclip-lite client. When supplied, every chained-harness iteration
   *  reserves and releases budget against the sidecar — without this, long
   *  auto-resume chains can blow past the daily USD cap with no 429.
   *  Mirrors the wiring in services/agent-claw/src/routes/chat.ts. */
  paperclip?: PaperclipClient;
}

export function registerSessionsRoute(
  app: FastifyInstance,
  deps: SessionsRouteDeps,
): void {
  // Per-route rate-limit config for the mutating session endpoints.
  // /plan/run can chain up to AGENT_PLAN_MAX_AUTO_TURNS harness iterations
  // per call, so we want a tighter cap than the global rate limit. Default
  // to 1/4 of the chat limit (e.g. 7/min if chat is 30/min).
  const sessionMutatingRateLimit = deps.config
    ? {
        config: {
          rateLimit: {
            max: Math.max(1, Math.floor(deps.config.AGENT_CHAT_RATE_LIMIT_MAX / 4)),
            timeWindow: deps.config.AGENT_CHAT_RATE_LIMIT_WINDOW_MS,
          },
        },
      }
    : {};

  app.get<{ Params: { id: string } }>("/api/sessions/:id", (req, reply) =>
    handleGetSession(req, reply, deps),
  );

  app.get<{ Querystring: { limit?: string } }>("/api/sessions", (req, reply) =>
    handleListSessions(req, reply, deps),
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/plan/run",
    sessionMutatingRateLimit,
    (req, reply) => handlePlanRun(req, reply, deps),
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/resume",
    sessionMutatingRateLimit,
    (req, reply) => handleResume(req, reply, deps),
  );

  app.post<{ Params: { id: string } }>(
    "/api/internal/sessions/:id/resume",
    sessionMutatingRateLimit,
    (req, reply) => handleInternalResume(req, reply, deps),
  );
}
