// STUB — real implementation lands in Task 13.
// This file exists so the unified tools.ts import resolves during typecheck
// between T9 and T13. The function throws at runtime until T13 replaces it.

import { z } from "zod";
import type { Pool } from "pg";
import type { McpKgClient, McpEmbedderClient } from "../mcp-clients.js";

export const SynthesizeInsightsInput = z.object({
  reaction_ids: z.array(z.string().min(1).max(64)).min(1).max(200),
  focus: z.string().min(1).max(1000).optional(),
  cited_fact_ids: z.array(z.string().uuid()).default([]),
});
export type SynthesizeInsightsInput = z.infer<typeof SynthesizeInsightsInput>;

export const SynthesizeInsightsOutput = z.object({
  insights: z.array(
    z.object({
      text: z.string(),
      cited_fact_ids: z.array(z.string()),
    }),
  ),
  dropped_fact_ids: z.array(z.string()).default([]),
});
export type SynthesizeInsightsOutput = z.infer<typeof SynthesizeInsightsOutput>;

export interface SynthesizeInsightsDeps {
  pool: Pool;
  kg: McpKgClient;
  embedder: McpEmbedderClient;
  userEntraId: string;
  seenFactIds: Set<string>;
}

// TODO: restore in T15 after T11-T14 land
export async function synthesizeInsights(
  _input: SynthesizeInsightsInput,
  _deps: SynthesizeInsightsDeps,
): Promise<SynthesizeInsightsOutput> {
  throw new Error("not implemented — lands in T13");
}
