// STUB — real implementation lands in Task 14.
// This file exists so the unified tools.ts import resolves during typecheck
// between T9 and T14. The function throws at runtime until T14 replaces it.

import { z } from "zod";
import type { Pool } from "pg";

export const ProposeHypothesisInput = z.object({
  hypothesis_text: z.string().min(20).max(5000),
  confidence: z.number().min(0).max(1),
  cited_fact_ids: z.array(z.string().uuid()).min(1).max(50),
});
export type ProposeHypothesisInput = z.infer<typeof ProposeHypothesisInput>;

export const ProposeHypothesisOutput = z.object({
  hypothesis_id: z.string().uuid(),
  confidence_tier: z.enum(["high", "medium", "low"]),
  rejected_fact_ids: z.array(z.string()).default([]),
});
export type ProposeHypothesisOutput = z.infer<typeof ProposeHypothesisOutput>;

export interface ProposeHypothesisDeps {
  pool: Pool;
  userEntraId: string;
  seenFactIds: Set<string>;
  agentTraceId?: string;
}

// TODO: restore in T15 after T11-T14 land
export async function proposeHypothesis(
  _input: ProposeHypothesisInput,
  _deps: ProposeHypothesisDeps,
): Promise<ProposeHypothesisOutput> {
  throw new Error("not implemented — lands in T14");
}
