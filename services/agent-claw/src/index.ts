// ChemClaw agent-claw service — Fastify HTTP entrypoint.
//
// Port 3101 (legacy agent was 3100 — running in parallel during Phase A–E).
//
// This file is intentionally minimal: it composes the bootstrap modules
// in `./bootstrap/*` in the right order. Each step is a small, testable
// function with a single responsibility:
//
//   buildServer       — Fastify + helmet/cors/rate-limit
//   buildDependencies — pool, llm, registries, skill loader, paperclip,
//                       shadow eval, plus all builtin tool registration
//   setupAuth         — getUser + 401 mapping for missing identity headers
//   registerReadyzRoute / registerAllRoutes — HTTP surface
//   startServer       — registry hydrate, hook load (gated), skills,
//                       app.listen, probe loop, signal handlers
//
// The order matters: routes need deps + auth, the start sequence needs
// the lifecycle hooks gate to run *after* the registry is hydrated.

import { loadConfig } from "./config.js";
import { initTracer } from "./observability/otel.js";
import { lifecycle } from "./core/runtime.js";
import { buildServer } from "./bootstrap/server.js";
import { buildDependencies } from "./bootstrap/dependencies.js";
import { setupAuthAndErrorHandler } from "./bootstrap/auth.js";
import { registerReadyzRoute } from "./bootstrap/probes.js";
import { registerAllRoutes } from "./bootstrap/routes.js";
import { startServer } from "./bootstrap/start.js";

const cfg = loadConfig();

// OTel tracer must be initialised before any routes are registered so the
// auto-instrumentation patches Fastify's request/response cycle in time.
initTracer({ langfuseHost: cfg.LANGFUSE_HOST });

const app = await buildServer(cfg);
const deps = buildDependencies(cfg);
const getUser = setupAuthAndErrorHandler(app, cfg);

registerAllRoutes(app, cfg, deps, getUser);
registerReadyzRoute(app, deps.pool);

// Re-export singletons for tests that import from "./index.js" directly.
export const pool = deps.pool;
export const registry = deps.registry;
export const llmProvider = deps.llmProvider;
export const promptRegistry = deps.promptRegistry;
export const skillLoader = deps.skillLoader;
export { lifecycle };
export { probeMcpTools } from "./bootstrap/probes.js";

await startServer(app, cfg, deps);
