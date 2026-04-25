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
