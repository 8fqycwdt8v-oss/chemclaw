// Tool type with Zod input/output schemas + execute(ctx, input).
// Phase A.1: definition only. Real builtin implementations land in Phase B.

import { z } from "zod";
import type { ToolContext } from "../core/types.js";

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
  /**
   * Optional metadata read by the harness (and surfaced to OTel spans).
   * - `readOnly: true` marks tools that don't mutate state — eligible for
   *   parallel-batch execution (Phase 5) and reflected on the tool span as
   *   `tool.read_only`.
   */
  annotations?: {
    readOnly?: boolean;
  };
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
