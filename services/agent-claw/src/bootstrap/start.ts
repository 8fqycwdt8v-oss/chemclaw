// Server startup sequence + signal-driven shutdown.
//
// Extracted from index.ts as part of the PR-6 god-file split. Owns the
// startup ordering contract:
//   1. Hydrate the tool registry from DB (non-fatal)
//   2. Load YAML hooks (FATAL — see MIN_EXPECTED_HOOKS gate)
//   3. Load skill packs from filesystem (non-fatal)
//   4. Load DB-backed skills from skill_library (non-fatal)
//   5. app.listen()
//   6. Start the mcp_tools probe loop
// Plus signal handlers for SIGINT/SIGTERM and last-resort
// unhandledRejection / uncaughtException loggers.

import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Deps } from "./dependencies.js";
import { loadHooks } from "../core/hook-loader.js";
import { lifecycle } from "../core/runtime.js";
import { startMcpProbeLoop } from "./probes.js";

// Hard-fail startup if the minimum-expected number of hooks isn't loaded.
// A misconfigured HOOKS_DIR otherwise produces a process that starts without
// redact-secrets / budget-guard / etc., quietly letting compound codes
// through LiteLLM and unbudgeted tool calls through every endpoint.
// 11 = 9 pre-rebuild hooks + session-events (Phase 4B) + permission (Phase 6).
// Bump every time BUILTIN_REGISTRARS gains an entry so a silent failure to
// load a new hook trips the startup gate instead of quietly downgrading
// the safety net.
const MIN_EXPECTED_HOOKS = 11;

export async function startServer(
  app: FastifyInstance,
  cfg: Config,
  deps: Deps,
): Promise<void> {
  // Install process-level handlers FIRST, before any awaits. The pre-PR-6
  // monolithic index.ts registered SIGINT / SIGTERM / unhandledRejection /
  // uncaughtException at module top level so the entire startup sequence
  // (registry hydrate, hook load, skills, app.listen) was covered by them.
  // Splitting startServer out moved the registration after app.listen,
  // which left a ~5-await window where a SIGTERM from k8s would default-
  // exit (no app.close / pool.end) and any unhandled rejection during
  // startup would bypass the structured logger. Hoisted here to restore
  // the v1.3.0 contract — see the post-session review log for details.
  registerProcessHandlers(app, deps);

  try {
    // 1. Load tools from DB (non-fatal if DB is unavailable during dev startup).
    try {
      await deps.registry.loadFromDb(deps.pool);
      app.log.info({ toolCount: deps.registry.size }, "tool registry hydrated from DB");
    } catch (err) {
      app.log.warn({ err }, "could not hydrate tool registry from DB — continuing with empty registry");
    }

    // 2. Load YAML hooks. HookDeps is assembled from existing top-level
    // singletons + AGENT_TOKEN_BUDGET so source-cache, compact-window,
    // and apply-skills registrars receive their required dependencies.
    try {
      const hookResult = await loadHooks(lifecycle, {
        pool: deps.pool,
        llm: deps.llmProvider,
        skillLoader: deps.skillLoader,
        allTools: deps.registry.all(),
        tokenBudget: cfg.AGENT_TOKEN_BUDGET,
      });
      app.log.info(hookResult, "lifecycle hooks loaded");
      if (hookResult.registered < MIN_EXPECTED_HOOKS) {
        throw new Error(
          `lifecycle hooks under-loaded: registered=${hookResult.registered}, expected>=${MIN_EXPECTED_HOOKS}; ` +
            `check HOOKS_DIR (skipped=${JSON.stringify(hookResult.skipped)})`,
        );
      }
    } catch (err) {
      app.log.error({ err }, "hook loader failed — refusing to start without lifecycle hooks");
      throw err;
    }

    // 3. Load skill packs (non-fatal).
    try {
      deps.skillLoader.load();
      app.log.info({ count: deps.skillLoader.size }, "skill packs loaded from filesystem");
    } catch (err) {
      app.log.warn({ err }, "skill loader failed — continuing without skills");
    }

    // 4. Load DB-backed skills from skill_library (non-fatal).
    try {
      const dbSkillResult = await deps.skillLoader.loadFromDb(deps.pool);
      app.log.info(dbSkillResult, "DB skills loaded from skill_library");
    } catch (err) {
      app.log.warn({ err }, "DB skill loader failed — continuing without DB skills");
    }

    // 4a. Audit skill→tool gaps. Pre-PR a SKILL.md `tools:` ref that
    // didn't exist in the runtime registry was silently filtered at
    // activation; the missing tool only surfaced mid-skill at runtime.
    // Surfacing at startup makes catalog drift loud.
    try {
      const toolIds = new Set<string>(deps.registry.all().map((t) => t.id));
      const gaps = deps.skillLoader.auditToolGaps(toolIds);
      if (gaps.size > 0) {
        for (const [skillId, missing] of gaps) {
          app.log.warn(
            { event: "skill_tool_gap", skill_id: skillId, missing_tools: missing },
            `skill '${skillId}' references ${missing.length} unknown tool(s); will be filtered at activation`,
          );
        }
      }
    } catch (err) {
      app.log.warn({ err }, "skill→tool gap audit failed — startup proceeds");
    }

    // 5. Bind the server.
    await app.listen({ host: cfg.AGENT_HOST, port: cfg.AGENT_PORT });
    app.log.info({ llmProvider: cfg.AGENT_MODEL, port: cfg.AGENT_PORT }, "agent-claw started");

    // 6. Start the mcp_tools health probe loop (non-blocking). Process-
    // level handlers were already installed at the top of startServer
    // so SIGINT / SIGTERM during the probe loop runs through the
    // structured shutdown path.
    startMcpProbeLoop(app, deps.pool);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

function registerProcessHandlers(app: FastifyInstance, deps: Deps): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down agent-claw");
    try {
      await app.close();
      await deps.pool.end();
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
}
