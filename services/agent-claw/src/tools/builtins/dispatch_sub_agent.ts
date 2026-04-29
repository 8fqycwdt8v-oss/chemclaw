// dispatch_sub_agent — Phase B.3 builtin tool.
//
// Allows the parent agent to spawn a specialized sub-agent (chemist, analyst,
// or reader) for a focused sub-task. The sub-agent's result is returned as a
// structured object containing the answer text, citations, steps used, and
// token usage.

import { z } from "zod";
import { defineTool } from "../tool.js";
import {
  spawnSubAgent,
  type SubAgentDeps,
  type SubAgentType,
} from "../../core/sub-agent.js";
import { lifecycle } from "../../core/runtime.js";
import type { Tool } from "../tool.js";
import type { LlmProvider } from "../../llm/provider.js";

// --------------------------------------------------------------------------
// Schemas
// --------------------------------------------------------------------------

export const DispatchSubAgentIn = z.object({
  type: z.enum(["chemist", "analyst", "reader"]),
  goal: z.string().min(1).max(2_000),
  inputs: z.record(z.unknown()).optional(),
  max_steps: z.number().int().min(1).max(20).optional(),
});
export type DispatchSubAgentInput = z.infer<typeof DispatchSubAgentIn>;

export const DispatchSubAgentOut = z.object({
  type: z.string(),
  text: z.string(),
  finish_reason: z.string(),
  citations: z.array(z.string()),
  steps_used: z.number(),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
  }),
});
export type DispatchSubAgentOutput = z.infer<typeof DispatchSubAgentOut>;

// --------------------------------------------------------------------------
// Factory
// --------------------------------------------------------------------------

/**
 * Build the dispatch_sub_agent tool.
 *
 * @param allTools  — the full tool catalog of the parent service
 * @param llm       — the LLM provider (shared with the parent)
 */
export function buildDispatchSubAgentTool(allTools: Tool[], llm: LlmProvider) {
  return defineTool({
    id: "dispatch_sub_agent",
    description:
      "Spawn a specialized sub-agent to handle a focused sub-task. " +
      "type='chemist': reaction similarity + KG queries. " +
      "type='analyst': CSV analysis + knowledge search + contradiction checks. " +
      "type='reader': document retrieval + full-text + original-doc access. " +
      "Returns the sub-agent's answer, cited fact/doc/rxn IDs, and budget summary. " +
      "Sub-agents run with their own seenFactIds and a fresh step budget (max 20 steps).",
    inputSchema: DispatchSubAgentIn,
    outputSchema: DispatchSubAgentOut,

    execute: async (ctx, input) => {
      const deps: SubAgentDeps = { allTools, llm, lifecycle };

      const result = await spawnSubAgent(
        input.type,
        {
          goal: input.goal,
          inputs: input.inputs ?? {},
          max_steps: input.max_steps,
        },
        ctx,
        deps,
      );

      // Phase G: persist sub-agent citations into the parent's seenFactIds.
      // The sub-agent ran in an isolated context (so its tools couldn't
      // accidentally pollute the parent's working memory), but its grounded
      // citations are exactly the facts the parent's anti-fabrication hook
      // should treat as verified going forward. Without this merge, the
      // parent re-rejects facts the sub-agent already grounded — over-
      // restrictive and forces redundant tool calls.
      for (const factId of result.citations) {
        ctx.seenFactIds.add(factId);
      }

      return {
        type: input.type,
        text: result.text,
        finish_reason: result.finishReason,
        citations: result.citations,
        steps_used: result.stepsUsed,
        usage: {
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
        },
      };
    },
  });
}
