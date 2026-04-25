// Shared types for the agent-claw harness.
// Keep this file lean — only types that cross module boundaries live here.

import type { Tool } from "../tools/tool.js";
import type { Lifecycle } from "./lifecycle.js";
import type { Budget } from "./budget.js";
import type { LlmProvider } from "../llm/provider.js";

// ---------------------------------------------------------------------------
// Tool execution context threaded through every hook and tool.execute call.
// Minimal for Phase A.1 — DB pool, MCP clients, prompt registry added in A.2.
// ---------------------------------------------------------------------------
export interface ToolContext {
  /** Entra-ID (or dev email) of the calling user; threads RLS. */
  userEntraId: string;
  /** Per-turn scratch space for hooks and tools to share state. */
  scratchpad: Map<string, unknown>;
  /**
   * Fact-IDs seen this turn — harvested by the anti-fabrication post_tool hook
   * from every tool output that contains fact_id fields.
   *
   * This is a VIEW into scratchpad.get("seenFactIds") provided by the harness
   * for convenient typed access. The init-scratch pre_turn hook initialises it
   * to an empty Set at the start of every turn, so it is always defined.
   *
   * Tools READ this (e.g. propose_hypothesis enforces a hard guard).
   * The anti-fabrication hook WRITES to it after each tool call.
   *
   * NOTE: tools may also read from ctx.scratchpad.get("seenFactIds") directly
   * for backward compatibility, but the typed accessor is preferred.
   */
  seenFactIds: Set<string>;
}

// ---------------------------------------------------------------------------
// The typed result of one step (one LLM call).
// ---------------------------------------------------------------------------
export type StepResult =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; toolId: string; input: unknown };

// ---------------------------------------------------------------------------
// Options passed to runHarness / buildAgent.
// ---------------------------------------------------------------------------
export interface HarnessOptions {
  /** Conversational history including any system message at index 0. */
  messages: Message[];
  /** Available tools this turn. */
  tools: Tool[];
  /** LLM provider implementation. */
  llm: LlmProvider;
  /** Budget caps. */
  budget: Budget;
  /** Lifecycle hook dispatcher. */
  lifecycle: Lifecycle;
  /** User + scratchpad context threaded through hooks and tools. */
  ctx: ToolContext;
}

// ---------------------------------------------------------------------------
// Final result returned by runHarness.
// ---------------------------------------------------------------------------
export interface HarnessResult {
  /** The final text produced by the model. */
  text: string;
  /** Why the loop stopped: "stop" | "max_steps" | "budget_exceeded". */
  finishReason: string;
  /** Number of LLM calls executed. */
  stepsUsed: number;
  /** Aggregate token usage across all steps. */
  usage: { promptTokens: number; completionTokens: number };
}

// ---------------------------------------------------------------------------
// LLM message shape (minimal, role + content only for Phase A.1).
// ---------------------------------------------------------------------------
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** tool id — only present when role === "tool" */
  toolId?: string;
}

// ---------------------------------------------------------------------------
// Hook payloads (one per lifecycle point).
// ---------------------------------------------------------------------------
export interface PreTurnPayload {
  ctx: ToolContext;
  messages: Message[];
}

export interface PreToolPayload {
  ctx: ToolContext;
  toolId: string;
  /** Mutable — hooks may rewrite input before execution. */
  input: unknown;
}

export interface PostToolPayload {
  ctx: ToolContext;
  toolId: string;
  input: unknown;
  /** Mutable — hooks may annotate / wrap output. */
  output: unknown;
}

export interface PreCompactPayload {
  ctx: ToolContext;
  messages: Message[];
}

export interface PostTurnPayload {
  ctx: ToolContext;
  finalText: string;
  stepsUsed: number;
}

// ---------------------------------------------------------------------------
// Re-export the five hook point names as a union so the registry is typed.
// ---------------------------------------------------------------------------
export type HookPoint =
  | "pre_turn"
  | "pre_tool"
  | "post_tool"
  | "pre_compact"
  | "post_turn";

// ---------------------------------------------------------------------------
// Citation — typed provenance record surfaced in tool-result events.
//
// Forward-compatible design:
//   - source_kind "original_doc" is reserved for Phase B's fetch_original_document
//     tool; `source_uri` will carry the signed URL returned by that tool.
//   - All fields except source_id and source_kind are optional so that tools
//     that don't have page numbers / snippets can still produce citations.
//   - Existing tools (canonicalize_smiles etc.) do NOT produce citations;
//     the field is present on the tool-result wire type but always undefined.
// ---------------------------------------------------------------------------
export interface Citation {
  /** Stable identifier for the source (chunk UUID, fact UUID, reaction UUID, URL…). */
  source_id: string;

  /** Kind of source — determines how source_uri should be interpreted. */
  source_kind:
    | "document_chunk"   // pgvector document_chunks row
    | "kg_fact"          // Neo4j bi-temporal fact node
    | "reaction"         // reactions table row (with DRFP)
    | "external_url"     // arbitrary HTTPS URL
    | "original_doc";    // Phase B: fetch_original_document return — signed URI to raw file

  /**
   * URI pointing to the source:
   *   - document_chunk:  internal chunk ID (Phase B adds /api/chunks/:id endpoint)
   *   - kg_fact:         internal fact_id
   *   - reaction:        internal reaction UUID
   *   - external_url:    the URL itself
   *   - original_doc:    signed storage URI (Phase B)
   */
  source_uri?: string;

  /** Short excerpt from the source (≤500 chars). */
  snippet?: string;

  /** Page number within a document (1-indexed). Only for document_chunk / original_doc. */
  page?: number;
}
