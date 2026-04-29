// Builtin tool registration for the agent-claw service.
//
// Pulled out of index.ts in PR-6 — the registration block was 88 LOC of
// repetitive `registerBuiltin` calls and is the second-most-volatile
// section of the entrypoint (one line per new tool). Isolating it here
// makes the entrypoint smaller, the tool list easier to scan, and the
// growth surface obvious.
//
// LIMS adapters remain unwired in this build. The post-tool source-cache
// hook + kg_source_cache projector remain available so any future LIMS
// MCP can register a builtin matching /^(query|fetch)_lims_/ and inherit
// the caching pipeline.
//
// forge_tool, run_program, induce_forged_tool_from_trace,
// dispatch_sub_agent, add_forged_tool_test are intentionally NOT
// registered here. They have either per-call user-identity dependencies
// (add_forged_tool_test) or sandbox/sub-agent orchestration deps
// (forge_tool family) that should be opt-in via dedicated route handlers
// / sub-agent spawner rather than the generic chat tool path.

import type { Pool } from "pg";
import type { Config } from "../config.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { LlmProvider } from "../llm/provider.js";
import type { PromptRegistry } from "../prompts/registry.js";
import { buildCanonicalizeSmilesTool } from "../tools/builtins/canonicalize_smiles.js";
import { buildCheckContradictionsTool } from "../tools/builtins/check_contradictions.js";
import { buildComputeConformerEnsembleTool } from "../tools/builtins/compute_conformer_ensemble.js";
import { buildIdentifyUnknownFromMsTool } from "../tools/builtins/identify_unknown_from_ms.js";
import { buildPredictMolecularPropertyTool } from "../tools/builtins/predict_molecular_property.js";
import { buildPredictReactionYieldTool } from "../tools/builtins/predict_reaction_yield.js";
import { buildQueryKgTool } from "../tools/builtins/query_kg.js";
import { buildProposeRetrosynthesisTool } from "../tools/builtins/propose_retrosynthesis.js";
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
import { buildQueryElnExperimentsTool } from "../tools/builtins/query_eln_experiments.js";
import { buildFetchElnEntryTool } from "../tools/builtins/fetch_eln_entry.js";
import { buildQueryElnCanonicalReactionsTool } from "../tools/builtins/query_eln_canonical_reactions.js";
import { buildFetchElnCanonicalReactionTool } from "../tools/builtins/fetch_eln_canonical_reaction.js";
import { buildFetchElnSampleTool } from "../tools/builtins/fetch_eln_sample.js";
import { buildQueryElnSamplesByEntryTool } from "../tools/builtins/query_eln_samples_by_entry.js";
import { buildQueryInstrumentRunsTool } from "../tools/builtins/query_instrument_runs.js";
import { buildFetchInstrumentRunTool } from "../tools/builtins/fetch_instrument_run.js";
import { buildQueryInstrumentDatasetsTool } from "../tools/builtins/query_instrument_datasets.js";
import { buildQueryInstrumentPersonsTool } from "../tools/builtins/query_instrument_persons.js";
import { buildManageTodosTool } from "../tools/builtins/manage_todos.js";
import { buildAskUserTool } from "../tools/builtins/ask_user.js";

export interface BuiltinToolDeps {
  cfg: Config;
  pool: Pool;
  llmProvider: LlmProvider;
  promptRegistry: PromptRegistry;
}

/**
 * Register every shipped builtin into the supplied registry. Cast through
 * `Tool` (unknown) to satisfy the registry's covariant `Tool<unknown,unknown>`
 * map — the cast moves with this module rather than living in index.ts.
 */
export function registerAllBuiltins(
  registry: ToolRegistry,
  deps: BuiltinToolDeps,
): void {
  const { cfg, pool, llmProvider, promptRegistry } = deps;
  type ToolBuiltin = import("../tools/tool.js").Tool;
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
  // The four tool ids match /^(query|fetch)_instrument_/ so the post-tool
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

  // ── Autonomy upgrade tools ───────────────────────────────────────────────
  // manage_todos and ask_user implement Claude-Code-like plan mode (per-session
  // checklist + clarification-back). Both rely on agent_sessions (created on
  // every /api/chat POST in routes/chat) and require a session_id in
  // ctx.scratchpad — which the chat route guarantees.
  registry.registerBuiltin("manage_todos", () => asTool(buildManageTodosTool(pool)));
  registry.registerBuiltin("ask_user", () => asTool(buildAskUserTool()));
}
