// Process-wide dependency wiring.
//
// Extracted from index.ts as part of the PR-6 god-file split. `buildDependencies`
// constructs the singletons (pool, llm provider, tool registry, prompt
// registry, skill loader, paperclip client, shadow evaluator) and registers
// every builtin tool factory into the registry. The function is sync —
// nothing here awaits — so callers can pass the returned `Deps` object
// directly to route registrars without a Promise.

import type { Pool } from "pg";
import type { Config } from "../config.js";
import { createPool } from "../db/pool.js";
import { LiteLLMProvider } from "../llm/litellm-provider.js";
import { ToolRegistry } from "../tools/registry.js";
import { PromptRegistry } from "../prompts/registry.js";
import { SkillLoader } from "../core/skills.js";
import { PaperclipClient } from "../core/paperclip-client.js";
import { ShadowEvaluator } from "../prompts/shadow-evaluator.js";
import type { Tool } from "../tools/tool.js";

// Chemistry / KG (URL-only).
import { buildCanonicalizeSmilesTool } from "../tools/builtins/canonicalize_smiles.js";
import { buildCheckContradictionsTool } from "../tools/builtins/check_contradictions.js";
import { buildComputeConformerEnsembleTool } from "../tools/builtins/compute_conformer_ensemble.js";
import { buildIdentifyUnknownFromMsTool } from "../tools/builtins/identify_unknown_from_ms.js";
import { buildPredictMolecularPropertyTool } from "../tools/builtins/predict_molecular_property.js";
import { buildPredictReactionYieldTool } from "../tools/builtins/predict_reaction_yield.js";
import { buildQueryKgTool } from "../tools/builtins/query_kg.js";
import { buildProposeRetrosynthesisTool } from "../tools/builtins/propose_retrosynthesis.js";
import { buildElucidateMechanismTool } from "../tools/builtins/elucidate_mechanism.js";
// Pool-backed tools.
import { buildAnalyzeCsvTool } from "../tools/builtins/analyze_csv.js";
import { buildExpandReactionContextTool } from "../tools/builtins/expand_reaction_context.js";
import { buildFetchOriginalDocumentTool } from "../tools/builtins/fetch_original_document.js";
import { buildFetchFullDocumentTool } from "../tools/builtins/fetch_full_document.js";
import { buildFindSimilarReactionsTool } from "../tools/builtins/find_similar_reactions.js";
import { buildSearchKnowledgeTool } from "../tools/builtins/search_knowledge.js";
import { buildStatisticalAnalyzeTool } from "../tools/builtins/statistical_analyze.js";
import { buildSynthesizeInsightsTool } from "../tools/builtins/synthesize_insights.js";
import { buildComputeConfidenceEnsembleTool } from "../tools/builtins/compute_confidence_ensemble.js";
import { buildProposeHypothesisTool } from "../tools/builtins/propose_hypothesis.js";
import { buildDraftSectionTool } from "../tools/builtins/draft_section.js";
// Source-system wrappers (Phase F.2 — Postgres-backed mock ELN).
import { buildQueryElnExperimentsTool } from "../tools/builtins/query_eln_experiments.js";
import { buildFetchElnEntryTool } from "../tools/builtins/fetch_eln_entry.js";
import { buildQueryElnCanonicalReactionsTool } from "../tools/builtins/query_eln_canonical_reactions.js";
import { buildFetchElnCanonicalReactionTool } from "../tools/builtins/fetch_eln_canonical_reaction.js";
import { buildFetchElnSampleTool } from "../tools/builtins/fetch_eln_sample.js";
import { buildQueryElnSamplesByEntryTool } from "../tools/builtins/query_eln_samples_by_entry.js";
// Source-system wrappers — LOGS-by-SciY analytical SDMS.
import { buildQueryInstrumentRunsTool } from "../tools/builtins/query_instrument_runs.js";
import { buildFetchInstrumentRunTool } from "../tools/builtins/fetch_instrument_run.js";
import { buildQueryInstrumentDatasetsTool } from "../tools/builtins/query_instrument_datasets.js";
import { buildQueryInstrumentPersonsTool } from "../tools/builtins/query_instrument_persons.js";
// Autonomy upgrade — Claude-Code-like plan mode.
import { buildManageTodosTool } from "../tools/builtins/manage_todos.js";
import { buildAskUserTool } from "../tools/builtins/ask_user.js";

export interface Deps {
  pool: Pool;
  llmProvider: LiteLLMProvider;
  registry: ToolRegistry;
  promptRegistry: PromptRegistry;
  skillLoader: SkillLoader;
  paperclipClient: PaperclipClient;
  shadowEvaluator: ShadowEvaluator;
}

export function buildDependencies(cfg: Config): Deps {
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

  // Shadow evaluator — fire-and-forgets a parallel call for any active shadow
  // prompts so the GEPA loop accumulates score data without affecting users.
  const shadowEvaluator = new ShadowEvaluator(promptRegistry, llmProvider, pool);

  registerBuiltinTools(registry, cfg, pool, promptRegistry, llmProvider);

  return { pool, llmProvider, registry, promptRegistry, skillLoader, paperclipClient, shadowEvaluator };
}

// Cast through Tool (unknown) to satisfy the registry's covariant Tool<unknown,unknown> map.
const asTool = (t: unknown): Tool => t as Tool;

function registerBuiltinTools(
  registry: ToolRegistry,
  cfg: Config,
  pool: Pool,
  promptRegistry: PromptRegistry,
  llmProvider: LiteLLMProvider,
): void {
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
  registry.registerBuiltin("elucidate_mechanism", () =>
    asTool(buildElucidateMechanismTool(cfg.MCP_SYNTHEGY_MECH_URL)),
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
  registry.registerBuiltin("query_instrument_persons", () =>
    asTool(buildQueryInstrumentPersonsTool(cfg.MCP_LOGS_SCIY_URL)),
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
}
