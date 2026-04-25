// Tool: synthesize_insights — LLM-based structured insight composition.
//
// The tool expands each reaction_id (bounded-parallel) for context, asks
// the LLM for structured JSON insights against the `tool.synthesize_insights`
// prompt, validates with Zod, and filters out insights whose evidence
// fact_ids the agent has not seen this turn (hallucination guard).

import { z } from "zod";
import type { Pool } from "pg";

import type { McpEmbedderClient, McpKgClient } from "../mcp-clients.js";
import type { PromptRegistry } from "../agent/prompts.js";
import type { LlmProvider } from "../llm/provider.js";
import {
  expandReactionContext,
  ExpandReactionContextInput,
} from "./expand-reaction-context.js";

export const SynthesizeInsightsInput = z.object({
  reaction_set: z.array(z.string().uuid()).min(3).max(500),
  question: z.string().min(20).max(2000),
  prior_stats: z.unknown().optional(),
});
export type SynthesizeInsightsInput = z.infer<typeof SynthesizeInsightsInput>;

const InsightSchema = z.object({
  claim: z.string().min(20).max(500),
  evidence_fact_ids: z.array(z.string().uuid()),
  evidence_reaction_ids: z.array(z.string().uuid()),
  support_strength: z.enum(["strong", "moderate", "weak"]),
  caveats: z.string().max(500).optional(),
});

export const SynthesizeInsightsOutput = z.object({
  insights: z.array(InsightSchema),
  summary: z.string(),
});
export type SynthesizeInsightsOutput = z.infer<typeof SynthesizeInsightsOutput>;

export interface SynthesizeInsightsDeps {
  pool: Pool;
  kg: McpKgClient;
  embedder: McpEmbedderClient;
  userEntraId: string;
  seenFactIds: Set<string>;
  prompts: PromptRegistry;
  llm: LlmProvider;
}

const MAX_PARALLEL = 20;

async function boundedMap<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: (R | undefined)[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out as R[];
}

export async function synthesizeInsights(
  input: SynthesizeInsightsInput,
  deps: SynthesizeInsightsDeps,
): Promise<SynthesizeInsightsOutput> {
  const parsed = SynthesizeInsightsInput.parse(input);

  const expanded = await boundedMap(parsed.reaction_set, MAX_PARALLEL, async (id) => {
    try {
      const e = await expandReactionContext(
        ExpandReactionContextInput.parse({ reaction_id: id }),
        {
          pool: deps.pool, kg: deps.kg, embedder: deps.embedder,
          userEntraId: deps.userEntraId,
        },
      );
      // Seed the per-turn set so the agent can later cite what was surfaced.
      for (const fid of e.surfaced_fact_ids) deps.seenFactIds.add(fid);
      return e;
    } catch {
      return null;
    }
  });

  const present = expanded.filter((e): e is NonNullable<typeof e> => e !== null);

  const { template } = await deps.prompts.getActive("tool.synthesize_insights");
  const raw = await deps.llm.completeJson({
    system: template,
    user: JSON.stringify({
      reactions: present,
      prior_stats: parsed.prior_stats ?? null,
      question: parsed.question,
    }),
  });

  const validated = SynthesizeInsightsOutput.parse(raw);

  // Hallucination guard — drop any insight citing unseen fact_ids.
  const seen = deps.seenFactIds;
  const reactionSet = new Set(parsed.reaction_set);
  const filteredInsights = validated.insights.filter((i) => {
    if (i.evidence_fact_ids.some((f) => !seen.has(f))) return false;
    if (i.evidence_reaction_ids.some((r) => !reactionSet.has(r))) return false;
    return true;
  });

  return {
    insights: filteredInsights,
    summary: validated.summary,
  };
}
