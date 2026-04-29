// Database pool bootstrap.
//
// Centralises pool creation so the entrypoint stays a thin wiring layer.
// Callers receive both the pool and the LLM-provider / prompt-registry /
// skill-loader / Paperclip / shadow-evaluator that the routes consume —
// all of these are constructed exactly once at startup, share the same
// pool, and outlive any individual request.
//
// TODO(PR-8): role-grants check (verify chemclaw_app exists, has FORCE
// RLS on every project-scoped table, BYPASSRLS where expected). Currently
// the contract is asserted only by the SQL in db/init/12_security_hardening.sql;
// a pre-flight check here would surface drift on the very first SELECT.

import type { Pool } from "pg";
import type { Config } from "../config.js";
import { createPool } from "../db/pool.js";
import { LiteLLMProvider } from "../llm/litellm-provider.js";
import { ToolRegistry } from "../tools/registry.js";
import { PromptRegistry } from "../prompts/registry.js";
import { SkillLoader } from "../core/skills.js";
import { PaperclipClient } from "../core/paperclip-client.js";
import { ShadowEvaluator } from "../prompts/shadow-evaluator.js";

export interface AgentDeps {
  pool: Pool;
  llmProvider: LiteLLMProvider;
  registry: ToolRegistry;
  promptRegistry: PromptRegistry;
  skillLoader: SkillLoader;
  paperclipClient: PaperclipClient;
  shadowEvaluator: ShadowEvaluator;
}

/**
 * Build the long-lived dependency graph: pool → llm → registry +
 * promptRegistry + skillLoader + Paperclip + shadow evaluator. All
 * routes thread these through `routeDeps` in the entrypoint.
 */
export function buildAgentDeps(cfg: Config): AgentDeps {
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

  // Paperclip-lite client — reserves/releases per-turn budget against the
  // sidecar (port 3200). When PAPERCLIP_URL is unset the client is a no-op.
  const paperclipClient = new PaperclipClient({ paperclipUrl: cfg.PAPERCLIP_URL });

  // Shadow evaluator — fire-and-forgets a parallel call for any active
  // shadow prompts so the GEPA loop accumulates score data without
  // affecting users.
  const shadowEvaluator = new ShadowEvaluator(promptRegistry, llmProvider, pool);

  return {
    pool,
    llmProvider,
    registry,
    promptRegistry,
    skillLoader,
    paperclipClient,
    shadowEvaluator,
  };
}
