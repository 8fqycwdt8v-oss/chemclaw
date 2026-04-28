// Tool type with Zod input/output schemas + execute(ctx, input).
// Phase A.1: definition only. Real builtin implementations land in Phase B.

import { z } from "zod";
import type { ToolContext } from "../core/types.js";

// ---------------------------------------------------------------------------
// ToolAnnotations — optional per-tool metadata that drives harness behaviour.
// Phase 5 introduces `readOnly` to enable parallel batch execution: when the
// LLM emits multiple tool calls in one assistant message, all read-only tools
// in the batch run via Promise.all rather than serialised one-at-a-time.
// ---------------------------------------------------------------------------
export interface ToolAnnotations {
  /** True if the tool only reads state (no DB writes, no external POST/PUT/DELETE,
   *  no filesystem writes, no LLM calls that mutate). Read-only tools may run in
   *  parallel within a tool batch. */
  readOnly?: boolean;
  /** True if the tool may interact with systems outside the agent's control
   *  (network, third-party APIs). Informational; not currently used by the harness. */
  openWorld?: boolean;
}

// ---------------------------------------------------------------------------
// Core Tool interface.
// I and O are inferred from the Zod schemas.
// ---------------------------------------------------------------------------
export interface Tool<I = unknown, O = unknown> {
  /** Unique identifier — used as the function name sent to the LLM. */
  id: string;
  /** One-sentence description shown to the LLM in the tool schema. */
  description: string;
  /** Zod schema for the input object. Validated before execute() is called. */
  inputSchema: z.ZodType<I>;
  /** Zod schema for the output. Validated after execute() returns. */
  outputSchema: z.ZodType<O>;
  /**
   * Execute the tool with the given context and parsed input.
   * Throw any Error to signal failure; the harness surfaces it as a tool error.
   */
  execute: (ctx: ToolContext, input: I) => Promise<O>;
  /** Optional metadata; absent annotations are treated as the conservative
   *  default (state-mutating). */
  annotations?: ToolAnnotations;
}

// ---------------------------------------------------------------------------
// Helper to define a tool with full type inference.
// Usage:
//   const myTool = defineTool({
//     id: "my_tool",
//     description: "Does something.",
//     inputSchema: z.object({ x: z.string() }),
//     outputSchema: z.object({ result: z.string() }),
//     execute: async (ctx, { x }) => ({ result: x.toUpperCase() }),
//   });
// ---------------------------------------------------------------------------
export function defineTool<I, O>(tool: Tool<I, O>): Tool<I, O> {
  return tool;
}

// ---------------------------------------------------------------------------
// JSON-Schema-compatible representation sent to the LLM.
// The harness converts Tool[] to this shape when calling LlmProvider.call().
// ---------------------------------------------------------------------------
export interface ToolSchema {
  id: string;
  description: string;
  /** JSON Schema for the input object. */
  inputJsonSchema: Record<string, unknown>;
}
