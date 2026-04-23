// STUB — real implementation lands in Task 12.
// This file exists so the unified tools.ts import resolves during typecheck
// between T9 and T12. The function throws at runtime until T12 replaces it.

import { z } from "zod";
import type { Pool } from "pg";
import type { McpTabiclClient } from "../mcp-clients.js";

export const StatisticalAnalyzeInput = z.object({
  reaction_ids: z.array(z.string().min(1).max(64)).min(1).max(500),
  analysis_type: z.enum([
    "predict_yield_for_similar",
    "rank_feature_importance",
    "compare_conditions",
  ]),
  query_reaction_id: z.string().min(1).max(64).optional(),
});
export type StatisticalAnalyzeInput = z.infer<typeof StatisticalAnalyzeInput>;

export const StatisticalAnalyzeOutput = z.object({
  analysis_type: z.string(),
  result: z.record(z.unknown()),
});
export type StatisticalAnalyzeOutput = z.infer<typeof StatisticalAnalyzeOutput>;

export interface StatisticalAnalyzeDeps {
  pool: Pool;
  tabicl: McpTabiclClient;
  userEntraId: string;
}

// TODO: restore in T15 after T11-T14 land
export async function statisticalAnalyze(
  _input: StatisticalAnalyzeInput,
  _deps: StatisticalAnalyzeDeps,
): Promise<StatisticalAnalyzeOutput> {
  throw new Error("not implemented — lands in T12");
}
