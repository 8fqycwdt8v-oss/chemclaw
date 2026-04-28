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

import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { LiteLLMProvider } from "./llm/litellm-provider.js";
import { ToolRegistry } from "./tools/registry.js";
import { buildCanonicalizeSmilesTool } from "./tools/builtins/canonicalize_smiles.js";
// Phase F.1 / chemistry MCP wrappers.
import { buildCheckContradictionsTool } from "./tools/builtins/check_contradictions.js";
import { buildComputeConformerEnsembleTool } from "./tools/builtins/compute_conformer_ensemble.js";
import { buildIdentifyUnknownFromMsTool } from "./tools/builtins/identify_unknown_from_ms.js";
import { buildPredictMolecularPropertyTool } from "./tools/builtins/predict_molecular_property.js";
import { buildPredictReactionYieldTool } from "./tools/builtins/predict_reaction_yield.js";
import { buildQueryKgTool } from "./tools/builtins/query_kg.js";
import { buildProposeRetrosynthesisTool } from "./tools/builtins/propose_retrosynthesis.js";
// Pool-backed tools.
import { buildAnalyzeCsvTool } from "./tools/builtins/analyze_csv.js";
import { buildExpandReactionContextTool } from "./tools/builtins/expand_reaction_context.js";
import { buildFetchOriginalDocumentTool } from "./tools/builtins/fetch_original_document.js";
import { buildFetchFullDocumentTool } from "./tools/builtins/fetch_full_document.js";
import { buildFindSimilarReactionsTool } from "./tools/builtins/find_similar_reactions.js";
import { buildSearchKnowledgeTool } from "./tools/builtins/search_knowledge.js";
import { buildStatisticalAnalyzeTool } from "./tools/builtins/statistical_analyze.js";
import { buildSynthesizeInsightsTool } from "./tools/builtins/synthesize_insights.js";
import { buildComputeConfidenceEnsembleTool } from "./tools/builtins/compute_confidence_ensemble.js";
import { buildProposeHypothesisTool } from "./tools/builtins/propose_hypothesis.js";
import { buildDraftSectionTool } from "./tools/builtins/draft_section.js";
// Source-system wrappers (Phase F.2 reboot — Postgres-backed mock ELN).
import { buildQueryElnExperimentsTool } from "./tools/builtins/query_eln_experiments.js";
import { buildFetchElnEntryTool } from "./tools/builtins/fetch_eln_entry.js";
import { buildQueryElnCanonicalReactionsTool } from "./tools/builtins/query_eln_canonical_reactions.js";
import { buildFetchElnCanonicalReactionTool } from "./tools/builtins/fetch_eln_canonical_reaction.js";
import { buildFetchElnSampleTool } from "./tools/builtins/fetch_eln_sample.js";
import { buildQueryElnSamplesByEntryTool } from "./tools/builtins/query_eln_samples_by_entry.js";
// Source-system wrappers — LOGS-by-SciY analytical SDMS (Phase F.2 reboot).
import { buildQueryInstrumentRunsTool } from "./tools/builtins/query_instrument_runs.js";
import { buildFetchInstrumentRunTool } from "./tools/builtins/fetch_instrument_run.js";
import { buildQueryInstrumentDatasetsTool } from "./tools/builtins/query_instrument_datasets.js";
// Autonomy upgrade — Claude-Code-like plan mode.
import { buildManageTodosTool } from "./tools/builtins/manage_todos.js";
import { buildAskUserTool } from "./tools/builtins/ask_user.js";
import { registerHealthzRoute } from "./routes/healthz.js";
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
import { PromptRegistry } from "./prompts/registry.js";
import { initTracer } from "./observability/otel.js";
import { loadHooks } from "./core/hook-loader.js";
import { lifecycle } from "./core/runtime.js";
import { SkillLoader } from "./core/skills.js";

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

const app = Fastify({
  logger: {
    level: cfg.AGENT_LOG_LEVEL,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie"],
      censor: "***",
    },
  },
  // Body size cap matches legacy agent (Phase A.4 parity).
  bodyLimit: cfg.AGENT_BODY_LIMIT_BYTES,
  disableRequestLogging: false,
  trustProxy: 1,
  genReqId: (req) => {
    const rid = req.headers["x-request-id"];
    return (typeof rid === "string" ? rid : undefined) ?? crypto.randomUUID();
  },
});

// ---------------------------------------------------------------------------
// Security plugins (parity with services/agent/src/index.ts).
// ---------------------------------------------------------------------------

// Helmet: HTTP security headers. CSP is off for a JSON API.
await app.register(helmet, {
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "same-site" },
});

// CORS: explicit allowlist from config.
const allowedOrigins = cfg.AGENT_CORS_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / server-to-server
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("origin not allowed"), false);
  },
  credentials: true,
});

// Global rate limit (per IP / user header). Probes are always exempt.
await app.register(rateLimit, {
  max: cfg.AGENT_RATE_LIMIT_MAX,
  timeWindow: cfg.AGENT_RATE_LIMIT_WINDOW_MS,
  keyGenerator: (req) => {
    const u = req.headers["x-user-entra-id"] ?? req.headers["x-forwarded-user"];
    if (typeof u === "string" && u.length > 0) return `user:${u}`;
    return `ip:${req.ip}`;
  },
  // Probes must stay cheap — never rate-limit them.
  allowList: (req) => req.url === "/healthz" || req.url === "/readyz",
});

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

const pool = createPool(cfg);
const llmProvider = new LiteLLMProvider({
  LITELLM_BASE_URL: cfg.LITELLM_BASE_URL,
  LITELLM_API_KEY: cfg.LITELLM_API_KEY,
  AGENT_MODEL: cfg.AGENT_MODEL,
  AGENT_MODEL_PLANNER: cfg.AGENT_MODEL_PLANNER,
  AGENT_MODEL_EXECUTOR: cfg.AGENT_MODEL_EXECUTOR,
  AGENT_MODEL_COMPACTOR: cfg.AGENT_MODEL_COMPACTOR,
  AGENT_MODEL_JUDGE: cfg.AGENT_MODEL_JUDGE,
});
const registry = new ToolRegistry();
const promptRegistry = new PromptRegistry(pool);
const skillLoader = new SkillLoader();

// Register builtin factories so loadFromDb() can find them.
// Cast through Tool (unknown) to satisfy the registry's covariant Tool<unknown,unknown> map.
type ToolBuiltin = import("./tools/tool.js").Tool;
const asTool = (t: unknown) => t as ToolBuiltin;

// Chemistry / KG (URL-only).
registry.registerBuiltin("canonicalize_smiles", () => asTool(buildCanonicalizeSmilesTool(cfg.MCP_RDKIT_URL)));
registry.registerBuiltin("check_contradictions", () => asTool(buildCheckContradictionsTool(cfg.MCP_KG_URL)));
registry.registerBuiltin("compute_conformer_ensemble", () => asTool(buildComputeConformerEnsembleTool(cfg.MCP_XTB_URL)));
registry.registerBuiltin("identify_unknown_from_ms", () => asTool(buildIdentifyUnknownFromMsTool(cfg.MCP_SIRIUS_URL)));
registry.registerBuiltin("predict_molecular_property", () => asTool(buildPredictMolecularPropertyTool(cfg.MCP_CHEMPROP_URL)));
registry.registerBuiltin("predict_reaction_yield", () => asTool(buildPredictReactionYieldTool(cfg.MCP_CHEMPROP_URL)));
registry.registerBuiltin("query_kg", () => asTool(buildQueryKgTool(cfg.MCP_KG_URL)));
registry.registerBuiltin("propose_retrosynthesis", () =>
  asTool(buildProposeRetrosynthesisTool(cfg.MCP_ASKCOS_URL, cfg.MCP_AIZYNTH_URL)),
);

// Pool-backed (read-only or scoped via withUserContext at call time inside the factory).
registry.registerBuiltin("analyze_csv", () => asTool(buildAnalyzeCsvTool(pool, cfg.MCP_DOC_FETCHER_URL)));
registry.registerBuiltin("expand_reaction_context", () => asTool(buildExpandReactionContextTool(pool, cfg.MCP_KG_URL)));
registry.registerBuiltin("fetch_original_document", () => asTool(buildFetchOriginalDocumentTool(pool, cfg.MCP_DOC_FETCHER_URL)));
registry.registerBuiltin("fetch_full_document", () => asTool(buildFetchFullDocumentTool(pool)));
registry.registerBuiltin("find_similar_reactions", () => asTool(buildFindSimilarReactionsTool(pool, cfg.MCP_DRFP_URL)));
registry.registerBuiltin("search_knowledge", () => asTool(buildSearchKnowledgeTool(pool, cfg.MCP_EMBEDDER_URL)));
registry.registerBuiltin("statistical_analyze", () => asTool(buildStatisticalAnalyzeTool(pool, cfg.MCP_TABICL_URL)));
registry.registerBuiltin("synthesize_insights", () =>
  asTool(buildSynthesizeInsightsTool(pool, cfg.MCP_KG_URL, promptRegistry, llmProvider)),
);
registry.registerBuiltin("compute_confidence_ensemble", () => asTool(buildComputeConfidenceEnsembleTool(pool)));
registry.registerBuiltin("propose_hypothesis", () => asTool(buildProposeHypothesisTool(pool)));
registry.registerBuiltin("draft_section", () => asTool(buildDraftSectionTool()));

// Source-system wrappers — local Postgres-backed mock ELN (Phase F.2 reboot).
// These five tool ids match /^(query|fetch)_eln_/ so the post-tool
// source-cache hook fires automatically and stamps :Fact provenance.
registry.registerBuiltin("query_eln_experiments", () =>
  asTool(buildQueryElnExperimentsTool(cfg.MCP_ELN_LOCAL_URL)),
);
registry.registerBuiltin("fetch_eln_entry", () =>
  asTool(buildFetchElnEntryTool(cfg.MCP_ELN_LOCAL_URL)),
);
registry.registerBuiltin("query_eln_canonical_reactions", () =>
  asTool(buildQueryElnCanonicalReactionsTool(cfg.MCP_ELN_LOCAL_URL)),
);
registry.registerBuiltin("fetch_eln_canonical_reaction", () =>
  asTool(buildFetchElnCanonicalReactionTool(cfg.MCP_ELN_LOCAL_URL)),
);
registry.registerBuiltin("fetch_eln_sample", () =>
  asTool(buildFetchElnSampleTool(cfg.MCP_ELN_LOCAL_URL)),
);
registry.registerBuiltin("query_eln_samples_by_entry", () =>
  asTool(buildQueryElnSamplesByEntryTool(cfg.MCP_ELN_LOCAL_URL)),
);

// Source-system wrappers — LOGS-by-SciY analytical SDMS (Phase F.2 reboot).
// The three tool ids match /^(query|fetch)_instrument_/ so the post-tool
// source-cache hook fires and stamps :Fact provenance for every dataset.
registry.registerBuiltin("query_instrument_runs", () =>
  asTool(buildQueryInstrumentRunsTool(cfg.MCP_LOGS_SCIY_URL)),
);
registry.registerBuiltin("fetch_instrument_run", () =>
  asTool(buildFetchInstrumentRunTool(cfg.MCP_LOGS_SCIY_URL)),
);
registry.registerBuiltin("query_instrument_datasets", () =>
  asTool(buildQueryInstrumentDatasetsTool(cfg.MCP_LOGS_SCIY_URL)),
);

// LIMS adapters remain unwired in this build. The post-tool source-cache
// hook + kg_source_cache projector remain available so any future LIMS
// MCP can register a builtin matching /^(query|fetch)_lims_/ and inherit
// the caching pipeline.

// Note: forge_tool, run_program, induce_forged_tool_from_trace, dispatch_sub_agent,
// add_forged_tool_test are intentionally NOT registered here. They have either
// per-call user-identity dependencies (add_forged_tool_test) or sandbox/sub-agent
// orchestration deps (forge_tool family) that should be opt-in via dedicated
// route handlers / sub-agent spawner rather than the generic chat tool path.

// ── Autonomy upgrade tools ───────────────────────────────────────────────
// manage_todos and ask_user implement Claude-Code-like plan mode (per-session
// checklist + clarification-back). Both rely on agent_sessions (created on
// every /api/chat POST in routes/chat.ts) and require a session_id in
// ctx.scratchpad — which the chat route guarantees.
registry.registerBuiltin("manage_todos", () => asTool(buildManageTodosTool(pool)));
registry.registerBuiltin("ask_user", () => asTool(buildAskUserTool()));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

registerHealthzRoute(app);

/**
 * Thrown when a non-dev request arrives without x-user-entra-id. Mapped to
 * a 401 by the global error handler below.
 */
class MissingUserError extends Error {
  constructor() {
    super("missing x-user-entra-id");
    this.name = "MissingUserError";
  }
}

// User extraction:
//   - dev mode: prefer x-dev-user-entra-id, else CHEMCLAW_DEV_USER_EMAIL.
//   - production: REQUIRE x-user-entra-id from the auth proxy. Missing header
//     means the auth proxy was bypassed or misconfigured — fail closed with 401
//     rather than silently treating the caller as a real user.
const getUser = (req: { headers: Record<string, string | string[] | undefined> }): string => {
  if (cfg.CHEMCLAW_DEV_MODE) {
    const hdr = req.headers["x-dev-user-entra-id"];
    return (typeof hdr === "string" && hdr.length > 0 ? hdr : undefined) ??
      cfg.CHEMCLAW_DEV_USER_EMAIL;
  }
  const hdr = req.headers["x-user-entra-id"];
  if (typeof hdr !== "string" || hdr.length === 0) {
    throw new MissingUserError();
  }
  return hdr;
};

// Map MissingUserError → 401 with the standard envelope so missing-auth-header
// failures don't surface as opaque 500s.
app.setErrorHandler((err, req, reply) => {
  if (err instanceof MissingUserError) {
    return reply.code(401).send({
      error: "unauthenticated",
      detail: "x-user-entra-id header is required",
    });
  }
  // Default Fastify error handler — preserves prior behavior for everything else.
  req.log.error({ err }, "unhandled error");
  // err is typed as FastifyError | Error | unknown across Fastify versions;
  // narrow defensively before reading statusCode/message.
  const e = err as { statusCode?: number; message?: string };
  reply.code(e.statusCode ?? 500).send({
    error: "internal",
    detail: cfg.CHEMCLAW_DEV_MODE ? e.message : undefined,
  });
});

const routeDeps = {
  config: cfg,
  pool,
  llm: llmProvider,
  registry,
  promptRegistry,
  skillLoader,
  getUser: getUser as (req: import("fastify").FastifyRequest) => string,
};

registerChatRoute(app, routeDeps);
registerDeepResearchRoute(app, routeDeps);
registerSkillsRoutes(app, {
  loader: skillLoader,
  pool,
  getUser: getUser as (req: import("fastify").FastifyRequest) => string,
});
registerPlanRoutes(app, routeDeps);
registerDocumentsRoute(app, { config: cfg, pool, getUser: getUser as (req: import("fastify").FastifyRequest) => string });
registerArtifactsRoutes(app, { pool, getUser: getUser as (req: import("fastify").FastifyRequest) => string });
registerLearnRoute(app, { pool, llm: llmProvider, getUser: getUser as (req: import("fastify").FastifyRequest) => string });
registerFeedbackRoute(app, {
  pool,
  getUser: getUser as (req: import("fastify").FastifyRequest) => string,
  langfuseHost: cfg.LANGFUSE_HOST,
  langfusePublicKey: cfg.LANGFUSE_PUBLIC_KEY,
  langfuseSecretKey: cfg.LANGFUSE_SECRET_KEY,
});
registerEvalRoute(app, {
  config: cfg,
  pool,
  promptRegistry,
  getUser: getUser as (req: import("fastify").FastifyRequest) => string,
});
registerOptimizerRoutes(app, {
  pool,
  getUser: getUser as (req: import("fastify").FastifyRequest) => string,
});
registerSessionsRoute(app, {
  pool,
  getUser: getUser as (req: import("fastify").FastifyRequest) => string,
  // Phase E + I: chained-run + resume endpoints share the chat harness deps.
  config: cfg,
  llm: llmProvider,
  registry,
  promptRegistry,
});

app.get("/readyz", async (_req, reply) => {
  // 1. Postgres ping.
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    app.log.warn({ err }, "readyz: Postgres not reachable");
    return reply.code(503).send({ status: "not_ready", reason: "postgres_unreachable" });
  }

  // 2. At least one mcp_tools row must be healthy.
  try {
    const { rowCount } = await pool.query(
      "SELECT 1 FROM mcp_tools WHERE health_status = 'healthy' AND enabled = true LIMIT 1",
    );
    if (!rowCount || rowCount === 0) {
      return reply
        .code(503)
        .send({ status: "not_ready", reason: "no_healthy_mcp_tools" });
    }
  } catch (err) {
    app.log.warn({ err }, "readyz: mcp_tools query failed");
    return reply
      .code(503)
      .send({ status: "not_ready", reason: "mcp_tools_query_failed" });
  }

  return { status: "ready" };
});

// ---------------------------------------------------------------------------
// mcp_tools health probe loop.
//
// Every 60 seconds, ping each enabled mcp_tools row's /readyz endpoint and
// update health_status + last_health_check in Postgres. This ensures /readyz
// has fresh data and prevents the "no_healthy_mcp_tools" gate from blocking
// indefinitely after seeding.
//
// The loop starts AFTER the server is listening (non-blocking).
// Uses native fetch (Node 18+ built-in); no external deps.
// ---------------------------------------------------------------------------

const MCP_HEALTH_PROBE_INTERVAL_MS = 60_000;

interface McpToolRow {
  service_name: string;
  base_url: string;
}

async function probeMcpTools(): Promise<void> {
  let rows: McpToolRow[];
  try {
    const result = await pool.query<McpToolRow>(
      "SELECT service_name, base_url FROM mcp_tools WHERE enabled = true",
    );
    rows = result.rows;
  } catch (err) {
    app.log.warn({ err }, "mcp-probe: could not read mcp_tools");
    return;
  }

  for (const row of rows) {
    const probeUrl = `${row.base_url.replace(/\/$/, "")}/readyz`;
    let newStatus: "healthy" | "unhealthy";
    try {
      const resp = await fetch(probeUrl, { signal: AbortSignal.timeout(5_000) });
      newStatus = resp.ok ? "healthy" : "unhealthy";
    } catch {
      newStatus = "unhealthy";
    }

    try {
      await pool.query(
        `UPDATE mcp_tools
            SET health_status = $1, last_health_check = NOW()
          WHERE service_name = $2`,
        [newStatus, row.service_name],
      );
      app.log.debug({ tool: row.service_name, status: newStatus }, "mcp-probe: updated");
    } catch (err) {
      app.log.warn({ err, tool: row.service_name }, "mcp-probe: update failed");
    }
  }
}

// Export for tests.
export { pool, registry, llmProvider, promptRegistry, lifecycle, skillLoader, probeMcpTools };

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

    // Load YAML hooks (non-fatal). HookDeps is assembled from existing
    // top-level singletons + AGENT_TOKEN_BUDGET so source-cache, compact-window,
    // and apply-skills registrars receive their required dependencies.
    try {
      const hookResult = await loadHooks(lifecycle, {
        pool,
        llm: llmProvider,
        skillLoader,
        allTools: registry.all(),
        tokenBudget: cfg.AGENT_TOKEN_BUDGET,
      });
      app.log.info(hookResult, "lifecycle hooks loaded");
    } catch (err) {
      app.log.warn({ err }, "hook loader failed — continuing without YAML hooks");
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
    const runProbeLoop = async () => {
      await probeMcpTools();
      setTimeout(() => void runProbeLoop(), MCP_HEALTH_PROBE_INTERVAL_MS);
    };
    setTimeout(() => void runProbeLoop(), MCP_HEALTH_PROBE_INTERVAL_MS);
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
