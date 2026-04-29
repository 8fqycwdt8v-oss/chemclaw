// ChemClaw agent-claw service — Fastify HTTP entrypoint.
// Phase A.4: token streaming, DR alias, helmet/cors/rate-limit parity, health probe.
//
// Port 3101 (legacy agent is 3100 — running in parallel during Phase A–E).
//
// Routes:
//   GET  /healthz              — liveness (no external deps)
//   GET  /readyz               — readiness (Postgres ping + mcp_tools health check)
//   POST /api/chat             — SSE streaming chat (token-by-token)
//   POST /api/deep_research    — Deep Research alias (DR mode marker)
//
// File layout (PR-6 split):
//   ./bootstrap/db.ts          — pool + LLM + registry + skill loader + Paperclip
//   ./bootstrap/server.ts      — Fastify + helmet + cors + rate-limit + auth handler
//   ./bootstrap/lifecycle.ts   — loadHooks + MIN_EXPECTED_HOOKS gate
//   ./bootstrap/probes.ts      — /healthz + /readyz + mcp_tools probe loop
//   ./bootstrap/tools.ts       — registerAllBuiltins (88 LOC of registerBuiltin calls)

import type { FastifyRequest } from "fastify";
import { loadConfig } from "./config.js";
import { initTracer } from "./observability/otel.js";
import { lifecycle } from "./core/runtime.js";
import { registerChatRoute } from "./routes/chat.js";
import { registerDeepResearchRoute } from "./routes/deep-research.js";
import { registerSkillsRoutes } from "./routes/skills.js";
import { registerPlanRoutes } from "./routes/plan.js";
import { registerDocumentsRoute } from "./routes/documents.js";
import { registerArtifactsRoutes } from "./routes/artifacts.js";
import { registerLearnRoute } from "./routes/learn.js";
import { registerFeedbackRoute } from "./routes/feedback.js";
import { registerEvalRoute } from "./routes/eval.js";
import { registerOptimizerRoutes } from "./routes/optimizer.js";
import { registerSessionsRoute } from "./routes/sessions.js";
import { buildAgentDeps } from "./bootstrap/db.js";
import { buildServer, makeGetUser } from "./bootstrap/server.js";
import { loadAndAssertHooks } from "./bootstrap/lifecycle.js";
import {
  registerProbeRoutes,
  startMcpProbeLoop,
  probeMcpTools as _probeMcpTools,
} from "./bootstrap/probes.js";
import { registerAllBuiltins } from "./bootstrap/tools.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const cfg = loadConfig();

// Initialize OTel tracer — must be called before any routes.
initTracer({
  langfuseHost: cfg.LANGFUSE_HOST,
});

const PORT = cfg.AGENT_PORT;
const HOST = cfg.AGENT_HOST;

const app = await buildServer(cfg);

const {
  pool,
  llmProvider,
  registry,
  promptRegistry,
  skillLoader,
  paperclipClient,
  shadowEvaluator,
} = buildAgentDeps(cfg);

// Register builtin factories so loadFromDb() can find them.
registerAllBuiltins(registry, { cfg, pool, llmProvider, promptRegistry });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const getUser = makeGetUser(cfg);

const routeDeps = {
  config: cfg,
  pool,
  llm: llmProvider,
  registry,
  promptRegistry,
  skillLoader,
  paperclip: paperclipClient,
  shadowEvaluator,
  getUser: getUser as (req: FastifyRequest) => string,
};

registerChatRoute(app, routeDeps);
registerDeepResearchRoute(app, routeDeps);
registerSkillsRoutes(app, {
  loader: skillLoader,
  pool,
  getUser: getUser as (req: FastifyRequest) => string,
});
registerPlanRoutes(app, routeDeps);
registerDocumentsRoute(app, { config: cfg, pool, getUser: getUser as (req: FastifyRequest) => string });
registerArtifactsRoutes(app, { pool, getUser: getUser as (req: FastifyRequest) => string });
registerLearnRoute(app, { pool, llm: llmProvider, getUser: getUser as (req: FastifyRequest) => string });
registerFeedbackRoute(app, {
  pool,
  promptRegistry,
  getUser: getUser as (req: FastifyRequest) => string,
  langfuseHost: cfg.LANGFUSE_HOST,
  langfusePublicKey: cfg.LANGFUSE_PUBLIC_KEY,
  langfuseSecretKey: cfg.LANGFUSE_SECRET_KEY,
});
registerEvalRoute(app, {
  config: cfg,
  pool,
  promptRegistry,
  llm: llmProvider,
  getUser: getUser as (req: FastifyRequest) => string,
});
registerOptimizerRoutes(app, {
  pool,
  getUser: getUser as (req: FastifyRequest) => string,
});
registerSessionsRoute(app, {
  pool,
  getUser: getUser as (req: FastifyRequest) => string,
  // Phase E + I: chained-run + resume endpoints share the chat harness deps.
  config: cfg,
  llm: llmProvider,
  registry,
  promptRegistry,
  // Same Paperclip client as the chat route — so chained-execution flows
  // are subject to the same daily-USD cap as a single chat turn.
  paperclip: paperclipClient,
});

registerProbeRoutes(app, { pool });

// Bound probe wrapper preserved as a free export for tests + symmetry with
// the pre-split surface.
const probeMcpTools = (): Promise<void> => _probeMcpTools(app, pool);

// Export for tests (preserved from the pre-split surface — see audit at
// /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit/docs/review/2026-04-29-codebase-audit/01-ts-hotspots.md).
export {
  pool,
  registry,
  llmProvider,
  promptRegistry,
  lifecycle,
  skillLoader,
  probeMcpTools,
};

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const start = async () => {
  try {
    // Load tools from DB (non-fatal if DB is unavailable during dev startup).
    try {
      await registry.loadFromDb(pool);
      app.log.info({ toolCount: registry.size }, "tool registry hydrated from DB");
    } catch (err) {
      app.log.warn({ err }, "could not hydrate tool registry from DB — continuing with empty registry");
    }

    // Load YAML hooks. HookDeps is assembled from existing top-level
    // singletons + AGENT_TOKEN_BUDGET so source-cache, compact-window,
    // and apply-skills registrars receive their required dependencies.
    try {
      const hookResult = await loadAndAssertHooks(lifecycle, {
        pool,
        llm: llmProvider,
        skillLoader,
        allTools: registry.all(),
        tokenBudget: cfg.AGENT_TOKEN_BUDGET,
      });
      app.log.info(hookResult, "lifecycle hooks loaded");
    } catch (err) {
      app.log.error({ err }, "hook loader failed — refusing to start without lifecycle hooks");
      throw err;
    }

    // Load skill packs (non-fatal).
    try {
      skillLoader.load();
      app.log.info({ count: skillLoader.size }, "skill packs loaded from filesystem");
    } catch (err) {
      app.log.warn({ err }, "skill loader failed — continuing without skills");
    }

    // Load DB-backed skills from skill_library (non-fatal).
    try {
      const dbSkillResult = await skillLoader.loadFromDb(pool);
      app.log.info(dbSkillResult, "DB skills loaded from skill_library");
    } catch (err) {
      app.log.warn({ err }, "DB skill loader failed — continuing without DB skills");
    }

    await app.listen({ host: HOST, port: PORT });
    app.log.info({ llmProvider: cfg.AGENT_MODEL, port: PORT }, "agent-claw started");

    // Start the mcp_tools health probe loop (non-blocking).
    startMcpProbeLoop(app, pool);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down agent-claw");
  try {
    await app.close();
    await pool.end();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Catch fire-and-forget promise rejections so a single bad probe / hook /
// background task doesn't crash the agent. Log structurally so the operator
// can see what went wrong; do NOT swallow silently — that just moves the
// bug somewhere harder to find.
process.on("unhandledRejection", (err) => {
  app.log.error({ err }, "unhandledRejection — investigate the offending await");
});
process.on("uncaughtException", (err) => {
  app.log.fatal({ err }, "uncaughtException — process state may be corrupt");
  // Best-effort graceful shutdown then exit; if the process state really
  // is corrupt, it should be restarted by the orchestrator anyway.
  void shutdown("uncaughtException");
});

await start();
