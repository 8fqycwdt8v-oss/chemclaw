// ChemClaw agent-claw service — Fastify HTTP entrypoint.
// Phase A.2: LiteLLM provider, Postgres pool, DB-backed tool registry.
//
// Port 3101 (legacy agent is 3100 — running in parallel during Phase A–E).
//
// Routes:
//   GET /healthz  — liveness (no external deps)
//   GET /readyz   — readiness (Postgres ping + mcp_tools health check)
//
// Phase A.3 will add:
//   POST /api/chat   — SSE streaming chat
//   POST /api/slash  — slash command router

import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { LiteLLMProvider } from "./llm/litellm-provider.js";
import { ToolRegistry } from "./tools/registry.js";
import { buildCanonicalizeSmilesTool } from "./tools/builtins/canonicalize_smiles.js";
import { registerHealthzRoute } from "./routes/healthz.js";
import { registerChatRoute } from "./routes/chat.js";
import { PromptRegistry } from "./prompts/registry.js";
import { loadHooks } from "./core/hook-loader.js";
import { Lifecycle } from "./core/lifecycle.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const cfg = loadConfig();

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
  disableRequestLogging: false,
  trustProxy: 1,
  genReqId: (req) => {
    const rid = req.headers["x-request-id"];
    return (typeof rid === "string" ? rid : undefined) ?? crypto.randomUUID();
  },
});

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

const pool = createPool(cfg);
const llmProvider = new LiteLLMProvider(cfg);
const registry = new ToolRegistry();
const promptRegistry = new PromptRegistry(pool);
const lifecycle = new Lifecycle();

// Register builtin factories so loadFromDb() can find them.
// Cast through Tool (unknown) to satisfy the registry's covariant Tool<unknown,unknown> map.
registry.registerBuiltin("canonicalize_smiles", () =>
  buildCanonicalizeSmilesTool(cfg.MCP_RDKIT_URL) as import("./tools/tool.js").Tool,
);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

registerHealthzRoute(app);

// Dev-mode user extraction: read from header or fall back to config default.
const getUser = (req: { headers: Record<string, string | string[] | undefined> }): string => {
  if (cfg.CHEMCLAW_DEV_MODE) {
    const hdr = req.headers["x-dev-user-entra-id"];
    return (typeof hdr === "string" ? hdr : undefined) ?? cfg.CHEMCLAW_DEV_USER_EMAIL;
  }
  // Production: read from validated Entra-ID header set by the auth proxy.
  const hdr = req.headers["x-user-entra-id"];
  return typeof hdr === "string" ? hdr : cfg.CHEMCLAW_DEV_USER_EMAIL;
};

registerChatRoute(app, {
  config: cfg,
  pool,
  llm: llmProvider,
  registry,
  promptRegistry,
  getUser: getUser as (req: import("fastify").FastifyRequest) => string,
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

    // Load YAML hooks (non-fatal).
    try {
      const hookResult = await loadHooks(lifecycle);
      app.log.info(hookResult, "lifecycle hooks loaded");
    } catch (err) {
      app.log.warn({ err }, "hook loader failed — continuing without YAML hooks");
    }

    await app.listen({ host: HOST, port: PORT });
    app.log.info({ llmProvider: cfg.AGENT_MODEL, port: PORT }, "agent-claw started");
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

// Export for test harness access.
export { pool, registry, llmProvider, promptRegistry, lifecycle };

await start();
