// synthesize_insights — Phase B.2 builtin.
//
// LLM-based structured insight composition over a reaction set.
// Expands each reaction (bounded parallel), calls LLM for JSON insights,
// then soft-drops any insight whose evidence_fact_ids are not in seenFactIds.
//
// seenFactIds is read from ctx.scratchpad (set by the anti-fabrication hook
// after each prior tool call). The tool does NOT write to seenFactIds itself.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import { buildExpandReactionContextTool, ExpandReactionContextIn } from "./expand_reaction_context.js";

// ---------- Schemas ----------------------------------------------------------

export const SynthesizeInsightsIn = z.object({
  reaction_set: z.array(z.string().uuid()).min(3).max(500),
  question: z.string().min(20).max(2000),
  prior_stats: z.unknown().optional(),
});
export type SynthesizeInsightsInput = z.infer<typeof SynthesizeInsightsIn>;

const InsightSchema = z.object({
  claim: z.string().min(20).max(500),
  evidence_fact_ids: z.array(z.string().uuid()),
  evidence_reaction_ids: z.array(z.string().uuid()),
  support_strength: z.enum(["strong", "moderate", "weak"]),
  caveats: z.string().max(500).optional(),
});

export const SynthesizeInsightsOut = z.object({
  insights: z.array(InsightSchema),
  summary: z.string(),
});
export type SynthesizeInsightsOutput = z.infer<typeof SynthesizeInsightsOut>;

const _LlmRawOut = z.object({
  insights: z.array(InsightSchema),
  summary: z.string(),
});

// ---------- Bounded parallel helper -----------------------------------------

const MAX_PARALLEL = 20;

async function boundedMap<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: (R | undefined)[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = idx++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return out as R[];
}

// ---------- Factory ----------------------------------------------------------

export function buildSynthesizeInsightsTool(
  pool: Pool,
  mcpKgUrl: string,
  prompts: PromptRegistry,
  llm: LlmProvider,
) {
  // Build an inner expand tool to reuse its logic.
  const expandTool = buildExpandReactionContextTool(pool, mcpKgUrl);

  return defineTool({
    id: "synthesize_insights",
    description:
      "LLM-based structured insight synthesis over a reaction set. " +
      "Expands each reaction for context, asks the LLM for JSON insights, " +
      "then drops any insight citing fact_ids not seen this turn (anti-fabrication).",
    inputSchema: SynthesizeInsightsIn,
    outputSchema: SynthesizeInsightsOut,

    execute: async (ctx, input) => {
      // Read per-turn seenFactIds from scratchpad.
      const seen = (ctx.scratchpad.get("seenFactIds") as Set<string> | undefined) ?? new Set<string>();

      // Expand each reaction (bounded parallel).
      const expanded = await boundedMap(
        input.reaction_set,
        MAX_PARALLEL,
        async (id) => {
          try {
            const result = await expandTool.execute(
              ctx,
              ExpandReactionContextIn.parse({ reaction_id: id }),
            );
            // Accumulate fact_ids into scratchpad set (pre-seeding for later guard).
            for (const fid of result.surfaced_fact_ids) {
              seen.add(fid);
            }
            ctx.scratchpad.set("seenFactIds", seen);
            return result;
          } catch {
            return null;
          }
        },
      );

      const present = expanded.filter(
        (e): e is NonNullable<typeof e> => e !== null,
      );

      const { template } = await prompts.getActive("tool.synthesize_insights");
      const raw = await llm.completeJson({
        system: template,
        user: JSON.stringify({
          reactions: present,
          prior_stats: input.prior_stats ?? null,
          question: input.question,
        }),
      });

      const validated = _LlmRawOut.parse(raw);

      const reactionSet = new Set(input.reaction_set);
      const filteredInsights = validated.insights.filter((insight) => {
        const hasUnseen = insight.evidence_fact_ids.some((f) => !seen.has(f));
        const hasUnknownRxn = insight.evidence_reaction_ids.some(
          (r) => !reactionSet.has(r),
        );
        if (hasUnseen || hasUnknownRxn) {
          // Soft-drop with no throw — log to console so it appears in traces.
          console.warn(
            "[synthesize_insights] dropping insight with unseen evidence:",
            insight.claim.slice(0, 80),
          );
          return false;
        }
        return true;
      });

      return SynthesizeInsightsOut.parse({
        insights: filteredInsights,
        summary: validated.summary,
      });
    },
  });
}
