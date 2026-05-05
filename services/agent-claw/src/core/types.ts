// Shared types for the agent-claw harness.
// Keep this file lean — only types that cross module boundaries live here.

import type { Tool } from "../tools/tool.js";
import type { Lifecycle } from "./lifecycle.js";
import type { Budget } from "./budget.js";
import type { LlmProvider } from "../llm/provider.js";
import type { StreamSink } from "./streaming-sink.js";

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
  /**
   * Optional lifecycle dispatcher threaded through to tool.execute so a tool
   * can fire fine-grained events (manage_todos → task_created/completed).
   * The harness wires this on the way in; tests / sub-agents that don't have
   * a Lifecycle in scope leave it undefined and tools tolerate the absence.
   */
  lifecycle?: Lifecycle;
  /**
   * Optional AbortSignal carrying the upstream request's lifetime. Tools
   * that perform long-running work (LLM calls, tool MCP postJson/getJson,
   * subprocesses) should observe this so a client disconnect propagates
   * down. The harness reads `signal` off `HarnessOptions`, sets it here,
   * and forwards it into the AsyncLocalStorage RequestContext so
   * postJson / getJson pick it up transparently. May be undefined when
   * the caller has no upstream signal (background tasks, tests).
   */
  signal?: AbortSignal;
  /**
   * Optional permission policy snapshot the outer harness was started
   * with. Threaded onto ctx by runHarness so tools that orchestrate
   * inner tool calls (today: run_orchestration_script's Monty bridge)
   * can re-resolve through the same allowlist / denylist / mode the
   * route set up. Undefined for legacy callers that don't pass
   * `permissions:` to runHarness.
   */
  permissions?: PermissionOptions;
}

// ---------------------------------------------------------------------------
// The typed result of one step (one LLM call).
//
// `tool_call` (singular) is the legacy / single-tool shape kept for wire
// compatibility with existing tests and the StubLlmProvider's enqueueToolCall.
// `tool_calls` (plural) is emitted by providers that support multi-tool
// responses (Phase 5 — the LiteLLM provider switches to this shape when the
// underlying model returns 2+ tool calls in one assistant message). step.ts
// normalises both to a single internal batch shape before execution.
// ---------------------------------------------------------------------------
export type StepResult =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; toolId: string; input: unknown }
  | { kind: "tool_calls"; calls: Array<{ toolId: string; input: unknown }> };

// ---------------------------------------------------------------------------
// Phase 6: Permission system primitives.
//
// PermissionMode controls how the resolver in core/permissions/resolver.ts
// gates tool calls. allowedTools / disallowedTools are matched by exact
// tool id; allowedTools also supports a single trailing "*" wildcard
// (e.g. "mcp__github__*"). permissionCallback is the explicit escape hatch
// when no rule matches and no permission_request hook produced a decision.
// ---------------------------------------------------------------------------
export type PermissionMode =
  // Tools not covered by allow/deny rules → fire permission_request hook;
  // if no resolution, deny.
  | "default"
  // Phase 3 of the configuration concept (Initiative 5):
  // Consult permission_request hook (DB-backed permission_policies);
  // ALLOW when no policy matches. The "no opinion → permissive" inversion
  // of `default` mode lets production routes opt into policy enforcement
  // without flipping every tool call to deny on day one.
  | "enforce"
  // Auto-approve filesystem-touching tools; other rules apply.
  | "acceptEdits"
  // No tool execution; route should emit a plan instead. Resolver returns
  // "defer" so step.ts treats it as denied (defense-in-depth) — routes are
  // expected to detect plan mode BEFORE entering the harness loop.
  | "plan"
  // Tools pre-approved via allowedTools run; everything else denied.
  | "dontAsk"
  // All tools run unchecked. ONLY for isolated/sandboxed environments.
  | "bypassPermissions";

export type PermissionResolution = "allow" | "deny" | "ask" | "defer";

export interface PermissionContext {
  toolId: string;
  input: unknown;
  ctx: ToolContext;
}

export type PermissionCallback = (
  pctx: PermissionContext,
) => Promise<PermissionResolution> | PermissionResolution;

export interface PermissionOptions {
  permissionMode?: PermissionMode;
  /** Exact match OR `mcp__server__*` trailing-wildcard. */
  allowedTools?: string[];
  /** Exact match. */
  disallowedTools?: string[];
  permissionCallback?: PermissionCallback;
}

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
  /**
   * Optional streaming sink. When set, the harness drives text steps via
   * llm.streamCompletion and emits onTextDelta per chunk plus tool / session /
   * finish notifications. When undefined, runHarness behaves identically to
   * today (single llm.call per step, no streaming).
   */
  streamSink?: StreamSink;
  /** Optional session id; passed through to the sink's onSession callback. */
  sessionId?: string;
  /**
   * Phase 6: optional permission policy. When undefined, the harness behaves
   * as before (only the pre_tool hooks gate tool calls). When set, the
   * resolver in core/permissions/resolver.ts runs BEFORE pre_tool dispatch
   * and can short-circuit the call with deny / defer.
   */
  permissions?: PermissionOptions;
  /**
   * Optional AbortSignal threaded into ctx + AsyncLocalStorage so that
   * client disconnects mid-stream propagate to LLM calls, MCP postJson /
   * getJson, and tool subprocesses. Routes pass `req.raw?.signal` from
   * Fastify's underlying Node IncomingMessage (Node 18+). On abort, the
   * harness lets the typed AbortError bubble out so the route's catch
   * + finally can record the cancellation, persist scratchpad with
   * finish_reason="cancelled", and emit the terminal SSE event.
   */
  signal?: AbortSignal;
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
  /**
   * Compaction trigger:
   *   - "auto"   — runHarness saw budget.shouldCompact() return true after a step.
   *   - "manual" — the user invoked /compact (chat.ts slash branch).
   *
   * Mirrors the Claude Agent SDK `SDKCompactBoundaryMessage.trigger` field.
   */
  trigger: "manual" | "auto";
  /** Estimated prompt-token count BEFORE compaction. */
  pre_tokens: number;
  /** Optional user-supplied summarization steering (manual /compact path only). */
  custom_instructions?: string | null;
}

export interface PostCompactPayload {
  ctx: ToolContext;
  trigger: "manual" | "auto";
  /** Estimated prompt-token count BEFORE compaction. */
  pre_tokens: number;
  /** Estimated prompt-token count AFTER compaction. */
  post_tokens: number;
}

export interface PostTurnPayload {
  ctx: ToolContext;
  finalText: string;
  stepsUsed: number;
}

// ---------------------------------------------------------------------------
// Phase 4B hook payloads — Claude-Code-shape additions.
// ---------------------------------------------------------------------------

export interface SessionStartPayload {
  ctx: ToolContext;
  sessionId: string;
  source: "create" | "resume" | "compact";
}

export interface SessionEndPayload {
  ctx: ToolContext;
  sessionId: string;
  finishReason: string;
}

export interface UserPromptSubmitPayload {
  ctx: ToolContext;
  prompt: string;
  sessionId: string | null;
}

export interface PostToolFailurePayload {
  ctx: ToolContext;
  toolId: string;
  input: unknown;
  error: Error;
  durationMs: number;
}

export interface PostToolBatchEntry {
  toolId: string;
  input: unknown;
  output: unknown;
}

export interface PostToolBatchPayload {
  ctx: ToolContext;
  batch: PostToolBatchEntry[];
}

// Phase 6 permissions: see docs/adr/009-permission-and-decision-contract.md
// and docs/adr/010-deferred-phases.md. The type is declared so downstream
// hook authors can register against it without a follow-up patch; the
// resolver in core/permissions/resolver.ts only fires when a route passes
// a `permissions` option to runHarness, which no production route does today.
export interface PermissionRequestPayload {
  ctx: ToolContext;
  toolId: string;
  input: unknown;
}

// SubAgent shapes are re-exported from core/sub-agent.ts (which imports
// these definitions). They live here to break the circular import that
// would otherwise form between core/types.ts and core/sub-agent.ts.
export type SubAgentType = "chemist" | "analyst" | "reader";

export interface SubAgentTaskSpec {
  /** What the sub-agent should accomplish. */
  goal: string;
  /** Named input values the sub-agent can reference in the goal. */
  inputs: Record<string, unknown>;
  /** Override step cap. */
  max_steps?: number;
  /** Override prompt token budget. */
  max_tokens?: number;
}

export interface SubAgentResult {
  text: string;
  finishReason: string;
  /** Fact/doc/rxn IDs collected by the seenFactIds set during the sub-turn. */
  citations: string[];
  stepsUsed: number;
  usage: { promptTokens: number; completionTokens: number };
}

export interface SubAgentStartPayload {
  ctx: ToolContext;
  type: SubAgentType;
  taskSpec: SubAgentTaskSpec;
  parentUserEntraId: string;
}

export interface SubAgentStopPayload {
  ctx: ToolContext;
  type: SubAgentType;
  result: SubAgentResult;
  durationMs: number;
}

export interface TaskCreatedPayload {
  ctx: ToolContext;
  todoId: string;
  content: string;
  ordering: number;
}

export interface TaskCompletedPayload {
  ctx: ToolContext;
  todoId: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Hook point names — Claude-Agent-SDK-shape union.
// ---------------------------------------------------------------------------
export type HookPoint =
  | "pre_turn"
  | "pre_tool"
  | "post_tool"
  | "pre_compact"
  | "post_compact"
  | "post_turn"
  // Phase 4B additions:
  | "session_start"
  | "session_end"
  | "user_prompt_submit"
  | "post_tool_failure"
  | "post_tool_batch"
  | "permission_request"
  | "subagent_start"
  | "subagent_stop"
  | "task_created"
  | "task_completed";

// ---------------------------------------------------------------------------
// Map of hook point → payload type. Lifecycle uses this to type its on() /
// dispatch() generics. Lives here (not lifecycle.ts) so callers that build
// typed HookCallbacks can import it without pulling in the dispatcher.
// ---------------------------------------------------------------------------
export interface HookPayloadMap {
  pre_turn: PreTurnPayload;
  pre_tool: PreToolPayload;
  post_tool: PostToolPayload;
  pre_compact: PreCompactPayload;
  post_compact: PostCompactPayload;
  post_turn: PostTurnPayload;
  // Phase 4B:
  session_start: SessionStartPayload;
  session_end: SessionEndPayload;
  user_prompt_submit: UserPromptSubmitPayload;
  post_tool_failure: PostToolFailurePayload;
  post_tool_batch: PostToolBatchPayload;
  permission_request: PermissionRequestPayload;
  subagent_start: SubAgentStartPayload;
  subagent_stop: SubAgentStopPayload;
  task_created: TaskCreatedPayload;
  task_completed: TaskCompletedPayload;
}

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
