// STUB — real implementation lands in Task 11.
// This file exists so the unified tools.ts import resolves during typecheck
// between T9 and T11. The function throws at runtime until T11 replaces it.

import { z } from "zod";
import type { Pool } from "pg";
import type { McpKgClient, McpEmbedderClient } from "../mcp-clients.js";

export const ExpandReactionContextInput = z.object({
  reaction_id: z.string().min(1).max(64),
  hop_limit: z.number().int().min(1).max(3).default(2),
});
export type ExpandReactionContextInput = z.infer<typeof ExpandReactionContextInput>;

export const ExpandReactionContextOutput = z.object({
  reaction_id: z.string(),
  surfaced_fact_ids: z.array(z.string()).default([]),
  context: z.record(z.unknown()).default({}),
});
export type ExpandReactionContextOutput = z.infer<typeof ExpandReactionContextOutput>;

export interface ExpandReactionContextDeps {
  pool: Pool;
  kg: McpKgClient;
  embedder: McpEmbedderClient;
  userEntraId: string;
}

// TODO: restore in T15 after T11-T14 land
export async function expandReactionContext(
  _input: ExpandReactionContextInput,
  _deps: ExpandReactionContextDeps,
): Promise<ExpandReactionContextOutput> {
  throw new Error("not implemented — lands in T11");
}
