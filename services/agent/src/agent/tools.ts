// Agent tool registry — every tool the autonomous ReAct loop can call.
//
// Control-flow philosophy: the agent is autonomous at the reasoning layer;
// tools are the bounded vocabulary of actions it can take. This file is the
// single source of truth for what the model can do in a turn.
//
// Each tool:
//   - declares a Zod input + output schema (validates both sides)
//   - receives per-turn context (user_entra_id etc.) via the `context` arg
//   - routes through the same RLS / redactor / rate-limit plumbing as HTTP calls

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Pool } from "pg";

import type {
  McpDrfpClient,
  McpEmbedderClient,
  McpKgClient,
  McpRdkitClient,
} from "../mcp-clients.js";
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

export interface ToolContext {
  userEntraId: string;
  pool: Pool;
  drfp: McpDrfpClient;
  rdkit: McpRdkitClient;
  embedder: McpEmbedderClient;
  kg: McpKgClient;
  /** Prompt version at the time of this invocation — used for audit. */
  promptVersion: number;
  /** Optional: latest user query, used by mark_research_done for the record. */
  queryText?: string;
  /** Optional: Langfuse or OTel trace id for cross-reference. */
  agentTraceId?: string;
}

/**
 * Build the tool registry for a given request context.
 *
 * Fresh registry per chat turn so the ToolContext (particularly
 * `userEntraId`) is captured in a closure and cannot leak between users.
 */
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
      return findSimilarReactions(input, {
        pool: ctx.pool,
        drfp: ctx.drfp,
        userEntraId: ctx.userEntraId,
      });
    },
  });

  const canonicalizeSmilesTool = createTool({
    id: "canonicalize_smiles",
    description:
      "Canonicalize a SMILES string via RDKit and return its InChIKey, " +
      "molecular formula, and molecular weight. Use when you need to verify " +
      "structure identity, compute a canonical form, or derive an InChIKey " +
      "for KG lookup.",
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
      const input = z
        .object({ smiles: z.string(), kekulize: z.boolean().optional() })
        .parse(context);
      return ctx.rdkit.canonicalize(input.smiles, input.kekulize ?? false);
    },
  });

  const searchKnowledgeTool = createTool({
    id: "search_knowledge",
    description:
      "Hybrid retrieval over the document corpus (SOPs, reports, method " +
      "validations, literature summaries). Default mode is 'hybrid' (dense " +
      "BGE-M3 + sparse trigram, fused via Reciprocal Rank Fusion). Returns " +
      "top-K chunks with document metadata for citation. Use this whenever " +
      "the user's question refers to documented procedures, reports, or " +
      "textual knowledge; prefer it over answering from memory.",
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
      "Fetch the full parsed Markdown of a document by its UUID. Use this " +
      "when a chunk from search_knowledge is relevant and you need the " +
      "complete context (e.g., the entire SOP section, not just the " +
      "retrieved fragment). Chunks are a finding strategy; documents are a " +
      "reading strategy.",
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

  return {
    find_similar_reactions: findSimilarReactionsTool,
    canonicalize_smiles: canonicalizeSmilesTool,
    search_knowledge: searchKnowledgeTool,
    fetch_full_document: fetchFullDocumentTool,
  } as const;
}

export type Tools = ReturnType<typeof buildTools>;

// ---------------------------------------------------------------------------
// DEEP RESEARCH toolkit — default toolkit plus KG + report composition.
// ---------------------------------------------------------------------------
export function buildDeepResearchTools(ctx: ToolContext) {
  const base = buildTools(ctx);

  const queryKgTool = createTool({
    id: "query_kg",
    description:
      "Direct knowledge-graph traversal. Given an entity reference and " +
      "optional predicate/direction/time snapshot, returns matching facts " +
      "with full provenance and confidence. Use this when the user asks " +
      "about structured relationships (e.g., 'what reagents were used in " +
      "experiment X?' or 'what did we believe about compound Y last " +
      "January?'). For text/document questions, prefer search_knowledge.",
    inputSchema: QueryKgInput,
    outputSchema: QueryKgOutput,
    execute: async ({ context }) => {
      const input = QueryKgInput.parse(context);
      return queryKg(input, { kg: ctx.kg });
    },
  });

  const checkContradictionsTool = createTool({
    id: "check_contradictions",
    description:
      "Surface contradictions for a KG entity: explicit CONTRADICTS edges " +
      "and parallel currently-valid facts with the same predicate but " +
      "different objects. Use BEFORE synthesising a claim across multiple " +
      "sources so you can report conflicts explicitly rather than silently " +
      "picking a winner.",
    inputSchema: CheckContradictionsInput,
    outputSchema: CheckContradictionsOutput,
    execute: async ({ context }) => {
      const input = CheckContradictionsInput.parse(context);
      return checkContradictions(input, { kg: ctx.kg });
    },
  });

  const draftSectionTool = createTool({
    id: "draft_section",
    description:
      "Compose one section of the final report from structured inputs. " +
      "Provide a heading, the list of citation refs you'll use, and the " +
      "body markdown. The tool validates citation format, flags undeclared " +
      "refs and unsourced claims, and returns the section markdown. This " +
      "does NOT save the section — call it to format each section; call " +
      "mark_research_done when the whole report is ready.",
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
      "TERMINAL tool. Call ONCE when the investigation is complete. Pass " +
      "the final title, executive summary, array of sections, optional " +
      "open_questions, optional contradictions, and optional citations. " +
      "The report is assembled into markdown, persisted under the calling " +
      "user, and its UUID returned. After calling this tool you are done.",
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

  return {
    ...base,
    query_kg: queryKgTool,
    check_contradictions: checkContradictionsTool,
    draft_section: draftSectionTool,
    mark_research_done: markResearchDoneTool,
  } as const;
}

export type DeepResearchTools = ReturnType<typeof buildDeepResearchTools>;
