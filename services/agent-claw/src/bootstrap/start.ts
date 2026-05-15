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
import { auditAgentAdminUsersCasing } from "../middleware/require-admin.js";
import {
  getOrCreateMontyPool,
  shutdownMontyPool,
} from "../runtime/monty/pool-singleton.js";

// Hard-fail startup if the minimum-expected number of hooks isn't loaded.
// A misconfigured HOOKS_DIR otherwise produces a process that starts without
// redact-secrets / budget-guard / etc., quietly letting compound codes
// through LiteLLM and unbudgeted tool calls through every endpoint.
// 20 = 9 pre-rebuild hooks + session-events (Phase 4B) + permission (Phase 6)
// + 9 lifecycle-telemetry stubs (cluster F: session_end, user_prompt_submit,
// post_tool_failure, post_tool_batch, subagent_start, subagent_stop,
// task_created, task_completed, post_compact).
// 22 = +detect-mcp-leakage post_tool (review §3.8 defense-in-depth tripwire).
// 23 = +loop-detector pre_tool (adaptive-replanning Phase A1).
// 24 = +fact-id-consistency-guard (review 2026-05-10 §2.6).
// 25 = +wiki-human-block-guard pre_tool (ADR 012 Phase 1 — knowledge wiki).
// 26 = +scheduled-substance-gate pre_tool (gap-plan H0.9, 2026-05-10).
// 27 = +redact-tool-output post_tool (Tranche 1 / Task G — defense-in-depth
// scrub of tool outputs before they enter the next-turn LLM context).
// 28 = +tool-invocation-emitter post_tool (+ post_tool_failure internally;
// Universal Knowledge Accumulation Phase 0, Task 8 — emits one
// `tool_invocation_complete` ingestion event per non-internal tool call,
// gated by feature flag `kg.auto_extraction.enabled`).
// Bump every time BUILTIN_REGISTRARS gains an entry so a silent failure to
// load a new hook trips the startup gate instead of quietly downgrading
// the safety net.
const MIN_EXPECTED_HOOKS = 28;

// Builtins gate. Mirrors MIN_EXPECTED_HOOKS for tools/builtins/: a new
// builtin module landing under `services/agent-claw/src/tools/builtins/`
// without a matching `registry.registerBuiltin(...)` call in
// `bootstrap/dependencies.ts:registerBuiltinTools` is otherwise an
// invisible omission — the route layer can call the tool by name, the
// catalog never lists it, and the agent silently never schedules it.
// Bumped whenever `registerBuiltinTools` gains a registration; if the
// gate trips, either add the missing registerBuiltin call or update
// this number with intent. The 2026-05-09 code-completeness review
// flagged this as an L3-5 hygiene gap. +1 for manage_plan
// (adaptive-replanning Phase A3). +4 for the Phase Z6 chromatography
// builtins (start_chrom_campaign, recommend_next_chrom_batch,
// materialize_chrom_method, query_chrom_columns). +4 for the
// knowledge-wiki builtins (read_article, list_articles, upsert_article,
// request_article — ADR 012 Phase 1; registered unconditionally, gated
// at call time by `wiki.enabled`). +1 for pubchem_ghs_lookup (gap-plan
// H0.4, 2026-05-10). +3 for the Phase Z6 chromatography Phases 2-5
// builtins (ingest_chrom_results, extract_chrom_pareto_front,
// simulate_chrom_retention). +1 for promote_to_kg (Universal Knowledge
// Accumulation Phase 0, Task 11 — explicit fact-promotion path for
// agent-derived INTERPRETED / HYPOTHESIZED / ABSTRACTED claims). +1 for
// request_investigation (Universal Knowledge Accumulation Phase 0, Task
// 12 — manual high-priority investigation_queue enqueue picked up by the
// Phase 3+ interpreter). The fs/shell builtins are NOT counted here
// because they're conditionally registered behind AGENT_FS_TOOLS_ENABLED
// — counting them would force the gate to fail in default-config
// deployments.
const MIN_EXPECTED_BUILTINS = 99;

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

  // 0. Builtins gate. `registerBuiltinTools` runs synchronously in
  //    `buildDeps`; by the time we reach `startServer`, every `registerBuiltin`
  //    call should have executed. A drift between
  //    `tools/builtins/<file>.ts` and `registerBuiltinTools` would land here
  //    as `builtinCount < MIN_EXPECTED_BUILTINS` and refuse to boot, the
  //    same way `MIN_EXPECTED_HOOKS` does for the hook registrars.
  //    Logged-only (no throw) when the registry is short, so a temporary
  //    Phase-deferred removal still surfaces in logs without stalling
  //    deploys; the `===` clause is the strict invariant once all
  //    registrations are stable.
  if (deps.registry.builtinCount < MIN_EXPECTED_BUILTINS) {
    throw new Error(
      `builtin registry under-loaded: builtinCount=${deps.registry.builtinCount}, ` +
        `expected>=${MIN_EXPECTED_BUILTINS}; ` +
        `every file under services/agent-claw/src/tools/builtins/ (excluding _* and *.test.ts) ` +
        `must have a matching registerBuiltin call in bootstrap/dependencies.ts:registerBuiltinTools. ` +
        `Bump MIN_EXPECTED_BUILTINS only when intentionally removing a builtin.`,
    );
  }
  app.log.info(
    { builtinCount: deps.registry.builtinCount },
    "builtin registry populated",
  );

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
      // Tighten the gate against the specific "missing registrar"
      // failure mode: a YAML file ADDED without a matching builtin
      // registrar would otherwise boot green (registered stays at 11 ≥
      // MIN_EXPECTED_HOOKS while the new file lands in `skipped` with
      // a "no built-in registrar" reason). The documented invariant in
      // CLAUDE.md is "every YAML in `hooks/` has a matching
      // `BUILTIN_REGISTRARS` entry"; this assertion enforces it
      // without breaking the legitimate skip reasons (enabled:false,
      // condition:false, parse error, missing name) — those still
      // surface in result.skipped at INFO above.
      const missingRegistrar = hookResult.skipped.filter((s) =>
        s.includes("no built-in registrar"),
      );
      if (missingRegistrar.length > 0) {
        throw new Error(
          `lifecycle hooks have YAML files with no matching BUILTIN_REGISTRARS entry: ` +
            `${JSON.stringify(missingRegistrar)}. Every YAML in hooks/ must have a matching ` +
            `registrar in core/hook-loader.ts (security-relevant hook silently disabled = boot-green disaster). ` +
            `Either add the registrar or set enabled:false in the YAML.`,
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

    // 4d. AGENT_ADMIN_USERS casing audit. Boot-time WARN when any
    // env-var entry differs only in case from an admin_roles row, so
    // operator drift is visible before it produces an orphaned grant.
    // Non-fatal — the env-var grant works regardless of case.
    try {
      await auditAgentAdminUsersCasing(deps.pool);
    } catch (err) {
      app.log.warn({ err }, "AGENT_ADMIN_USERS casing audit failed — startup proceeds");
    }

    // 5. Bind the server.
    await app.listen({ host: cfg.AGENT_HOST, port: cfg.AGENT_PORT });
    app.log.info({ llmProvider: cfg.AGENT_MODEL, port: cfg.AGENT_PORT }, "agent-claw started");

    // 6. Start the mcp_tools health probe loop (non-blocking). Process-
    // level handlers were already installed at the top of startServer
    // so SIGINT / SIGTERM during the probe loop runs through the
    // structured shutdown path.
    startMcpProbeLoop(app, deps.pool);

    // 7. Eagerly initialize the Monty warm child pool in the background
    // so the first run_orchestration_script call doesn't pay cold-start
    // for both the children and the resolver lookup. The singleton
    // returns undefined if monty.enabled / monty.binary_path / size=0
    // gates aren't satisfied — no children are spawned in that case.
    void getOrCreateMontyPool(deps.configRegistry).catch((err: unknown) => {
      app.log.warn({ err }, "monty pool eager init failed — falls back to per-call spawn");
    });
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
      shutdownMontyPool();
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
