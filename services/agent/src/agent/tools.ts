// Unified agent tool registry. One catalog, no modes — the agent
// chooses which tools to invoke per request.

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Pool } from "pg";

import type {
  McpDrfpClient,
  McpEmbedderClient,
  McpKgClient,
  McpRdkitClient,
  McpTabiclClient,
} from "../mcp-clients.js";
import type { PromptRegistry } from "./prompts.js";
import type { LlmProvider } from "../llm/provider.js";
import {
  FindSimilarReactionsInput,
  FindSimilarReactionsOutput,
  findSimilarReactions,
} from "../tools/find-similar-reactions.js";
import {
  SearchKnowledgeInput,
  SearchKnowledgeOutput,
  searchKnowledge,
} from "../tools/search-knowledge.js";
import {
  FetchFullDocumentInput,
  FetchFullDocumentOutput,
  fetchFullDocument,
} from "../tools/fetch-full-document.js";
import {
  QueryKgInput,
  QueryKgOutput,
  queryKg,
} from "../tools/query-kg.js";
import {
  CheckContradictionsInput,
  CheckContradictionsOutput,
  checkContradictions,
} from "../tools/check-contradictions.js";
import {
  DraftSectionInput,
  DraftSectionOutput,
  draftSection,
} from "../tools/draft-section.js";
import {
  MarkResearchDoneInput,
  MarkResearchDoneOutput,
  markResearchDone,
} from "../tools/mark-research-done.js";
import {
  ExpandReactionContextInput,
  ExpandReactionContextOutput,
  expandReactionContext,
} from "../tools/expand-reaction-context.js";
import {
  StatisticalAnalyzeInput,
  StatisticalAnalyzeOutput,
  statisticalAnalyze,
} from "../tools/statistical-analyze.js";
import {
  SynthesizeInsightsInput,
  SynthesizeInsightsOutput,
  synthesizeInsights,
} from "../tools/synthesize-insights.js";
import {
  ProposeHypothesisInput,
  ProposeHypothesisOutput,
  proposeHypothesis,
} from "../tools/propose-hypothesis.js";

export interface ToolContext {
  userEntraId: string;
  pool: Pool;
  drfp: McpDrfpClient;
  rdkit: McpRdkitClient;
  embedder: McpEmbedderClient;
  kg: McpKgClient;
  tabicl: McpTabiclClient;
  /** Per-turn set of fact_ids surfaced by any tool. Mutated in place. */
  seenFactIds: Set<string>;
  /** Prompt version at the time of this invocation. */
  promptVersion: number;
  /** Prompt registry — used by tools that need to load their own prompt. */
  prompts: PromptRegistry;
  /** LLM provider — used by tools that need direct model access (e.g. synthesize_insights). */
  llm: LlmProvider;
  queryText?: string;
  agentTraceId?: string;
}

/**
 * Add a collection of fact_ids to the seen-set. Tools call this after they
 * surface fact_ids to the model so that propose_hypothesis can later verify
 * the agent actually saw them.
 */
export function recordSeenFactIds(
  ctx: ToolContext,
  ids: Iterable<string>,
): void {
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0) ctx.seenFactIds.add(id);
  }
}

export function buildTools(ctx: ToolContext) {
  const findSimilarReactionsTool = createTool({
    id: "find_similar_reactions",
    description:
      "Find reactions similar to a seed reaction SMILES across the user's " +
      "accessible projects. Uses DRFP (Differential Reaction Fingerprint) " +
      "for similarity; results are cosine-sorted and RLS-scoped.",
    inputSchema: FindSimilarReactionsInput,
    outputSchema: FindSimilarReactionsOutput,
    execute: async ({ context }) => {
      const input = FindSimilarReactionsInput.parse(context);
      const out = await findSimilarReactions(input, {
        pool: ctx.pool,
        drfp: ctx.drfp,
        userEntraId: ctx.userEntraId,
      });
      // find_similar_reactions returns reaction_ids, not fact_ids; nothing to seed.
      return out;
    },
  });

  const canonicalizeSmilesTool = createTool({
    id: "canonicalize_smiles",
    description:
      "Canonicalize a SMILES string via RDKit and return its InChIKey, " +
      "molecular formula, and molecular weight.",
    inputSchema: z.object({
      smiles: z.string().min(1).max(10_000),
      kekulize: z.boolean().optional(),
    }),
    outputSchema: z.object({
      canonical_smiles: z.string(),
      inchikey: z.string(),
      formula: z.string(),
      mw: z.number(),
    }),
    execute: async ({ context }) => {
      const input = z.object({ smiles: z.string(), kekulize: z.boolean().optional() }).parse(context);
      return ctx.rdkit.canonicalize(input.smiles, input.kekulize ?? false);
    },
  });

  const searchKnowledgeTool = createTool({
    id: "search_knowledge",
    description:
      "Hybrid retrieval over the document corpus (SOPs, reports, method " +
      "validations, literature summaries). Returns top-K chunks with " +
      "document metadata for citation.",
    inputSchema: SearchKnowledgeInput,
    outputSchema: SearchKnowledgeOutput,
    execute: async ({ context }) => {
      const input = SearchKnowledgeInput.parse(context);
      return searchKnowledge(input, {
        pool: ctx.pool,
        embedder: ctx.embedder,
        userEntraId: ctx.userEntraId,
      });
    },
  });

  const fetchFullDocumentTool = createTool({
    id: "fetch_full_document",
    description:
      "Fetch the full parsed Markdown of a document by its UUID.",
    inputSchema: FetchFullDocumentInput,
    outputSchema: FetchFullDocumentOutput,
    execute: async ({ context }) => {
      const input = FetchFullDocumentInput.parse(context);
      return fetchFullDocument(input, {
        pool: ctx.pool,
        userEntraId: ctx.userEntraId,
      });
    },
  });

  const queryKgTool = createTool({
    id: "query_kg",
    description:
      "Direct knowledge-graph traversal. Returns matching facts with full " +
      "provenance and confidence. Use for structured relationships and " +
      "temporal snapshots.",
    inputSchema: QueryKgInput,
    outputSchema: QueryKgOutput,
    execute: async ({ context }) => {
      const input = QueryKgInput.parse(context);
      const out = await queryKg(input, { kg: ctx.kg });
      recordSeenFactIds(ctx, (out.facts ?? []).map((f) => f.fact_id));
      return out;
    },
  });

  const checkContradictionsTool = createTool({
    id: "check_contradictions",
    description:
      "Surface contradictions for a KG entity: explicit CONTRADICTS edges " +
      "and parallel currently-valid facts with the same predicate but " +
      "different objects.",
    inputSchema: CheckContradictionsInput,
    outputSchema: CheckContradictionsOutput,
    execute: async ({ context }) => {
      const input = CheckContradictionsInput.parse(context);
      const out = await checkContradictions(input, { kg: ctx.kg });
      // CheckContradictions surfaces fact_ids inside its output shape.
      const ids: string[] = [];
      const walk = (v: unknown) => {
        if (v && typeof v === "object") {
          if ("fact_id" in (v as any) && typeof (v as any).fact_id === "string") {
            ids.push((v as any).fact_id);
          }
          Object.values(v as Record<string, unknown>).forEach(walk);
        }
      };
      walk(out);
      recordSeenFactIds(ctx, ids);
      return out;
    },
  });

  const draftSectionTool = createTool({
    id: "draft_section",
    description:
      "Compose one section of a report from structured inputs; validates " +
      "citation format. Does NOT persist — call mark_research_done when " +
      "the whole report is ready.",
    inputSchema: DraftSectionInput,
    outputSchema: DraftSectionOutput,
    execute: async ({ context }) => {
      const input = DraftSectionInput.parse(context);
      return draftSection(input);
    },
  });

  const markResearchDoneTool = createTool({
    id: "mark_research_done",
    description:
      "TERMINAL. Assemble the final report and persist under the calling " +
      "user. After calling this tool you are done.",
    inputSchema: MarkResearchDoneInput,
    outputSchema: MarkResearchDoneOutput,
    execute: async ({ context }) => {
      const input = MarkResearchDoneInput.parse(context);
      return markResearchDone(input, {
        pool: ctx.pool,
        userEntraId: ctx.userEntraId,
        queryText: ctx.queryText ?? "",
        promptVersion: ctx.promptVersion,
        agentTraceId: ctx.agentTraceId,
      });
    },
  });

  const expandReactionContextTool = createTool({
    id: "expand_reaction_context",
    description:
      "For a given reaction_id, retrieve reagents, conditions, outcomes, " +
      "failures (from KG), citations, and (hop_limit=2) predecessors. " +
      "Surfaces fact_ids usable for citation by propose_hypothesis.",
    inputSchema: ExpandReactionContextInput,
    outputSchema: ExpandReactionContextOutput,
    execute: async ({ context }) => {
      const input = ExpandReactionContextInput.parse(context);
      const out = await expandReactionContext(input, {
        pool: ctx.pool,
        kg: ctx.kg,
        embedder: ctx.embedder,
        userEntraId: ctx.userEntraId,
      });
      recordSeenFactIds(ctx, out.surfaced_fact_ids ?? []);
      return out;
    },
  });

  const statisticalAnalyzeTool = createTool({
    id: "statistical_analyze",
    description:
      "Fit TabICL in-context on a supplied reaction set and answer one of: " +
      "predict_yield_for_similar, rank_feature_importance, compare_conditions " +
      "(the last is pure SQL aggregation, no ML).",
    inputSchema: StatisticalAnalyzeInput,
    outputSchema: StatisticalAnalyzeOutput,
    execute: async ({ context }) => {
      const input = StatisticalAnalyzeInput.parse(context);
      return statisticalAnalyze(input, {
        pool: ctx.pool,
        tabicl: ctx.tabicl,
        userEntraId: ctx.userEntraId,
      });
    },
  });

  const synthesizeInsightsTool = createTool({
    id: "synthesize_insights",
    description:
      "Compose structured cross-project insights over a reaction set. Drops " +
      "any fact_id the agent has not seen in this turn (hallucination guard).",
    inputSchema: SynthesizeInsightsInput,
    outputSchema: SynthesizeInsightsOutput,
    execute: async ({ context }) => {
      const input = SynthesizeInsightsInput.parse(context);
      const out = await synthesizeInsights(input, {
        pool: ctx.pool,
        kg: ctx.kg,
        embedder: ctx.embedder,
        userEntraId: ctx.userEntraId,
        seenFactIds: ctx.seenFactIds,
        prompts: ctx.prompts,
        llm: ctx.llm,
      });
      return out;
    },
  });

  const proposeHypothesisTool = createTool({
    id: "propose_hypothesis",
    description:
      "Non-terminal. Persist a hypothesis with ≥1 cited fact_ids. Rejects " +
      "citations that the agent has not seen in this turn. Emits the " +
      "hypothesis_proposed event for KG projection.",
    inputSchema: ProposeHypothesisInput,
    outputSchema: ProposeHypothesisOutput,
    execute: async ({ context }) => {
      const input = ProposeHypothesisInput.parse(context);
      return proposeHypothesis(input, {
        pool: ctx.pool,
        userEntraId: ctx.userEntraId,
        seenFactIds: ctx.seenFactIds,
        agentTraceId: ctx.agentTraceId,
      });
    },
  });

  return {
    search_knowledge: searchKnowledgeTool,
    fetch_full_document: fetchFullDocumentTool,
    canonicalize_smiles: canonicalizeSmilesTool,
    find_similar_reactions: findSimilarReactionsTool,
    query_kg: queryKgTool,
    check_contradictions: checkContradictionsTool,
    draft_section: draftSectionTool,
    mark_research_done: markResearchDoneTool,
    expand_reaction_context: expandReactionContextTool,
    statistical_analyze: statisticalAnalyzeTool,
    synthesize_insights: synthesizeInsightsTool,
    propose_hypothesis: proposeHypothesisTool,
  } as const;
}

export type Tools = ReturnType<typeof buildTools>;
