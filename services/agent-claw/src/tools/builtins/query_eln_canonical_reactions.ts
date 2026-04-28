// query_eln_canonical_reactions — wraps mcp-eln-local POST /reactions/query.
//
// Reads the OFAT-aware view: each canonical reaction returns one row with
// ofat_count + mean_yield aggregated from its child entries. Lets the agent
// rank chemistry families by OFAT campaign size before drilling in.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import {
  CanonicalReactionSchema,
  type CanonicalReaction,
} from "./_eln_shared.js";

export const QueryElnCanonicalReactionsIn = z.object({
  family: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9_\-]+$/, "family must be alphanumeric/_/-")
    .optional(),
  project_code: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9_\-\.]+$/, "project_code must be alphanumeric/.-/_")
    .optional(),
  step_number: z.number().int().min(0).max(100).optional(),
  min_ofat_count: z.number().int().min(0).max(10_000).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type QueryElnCanonicalReactionsInput = z.infer<
  typeof QueryElnCanonicalReactionsIn
>;

export const QueryElnCanonicalReactionsOut = z.object({
  items: z.array(CanonicalReactionSchema),
});
export type QueryElnCanonicalReactionsOutput = {
  items: CanonicalReaction[];
};

const TIMEOUT_MS = 15_000;

export function buildQueryElnCanonicalReactionsTool(mcpUrl: string) {
  const base = mcpUrl.replace(/\/$/, "");

  return defineTool({
    id: "query_eln_canonical_reactions",
    description:
      "Query canonical reactions in the local mock ELN with OFAT campaign sizes. " +
      "Each result is one canonical reaction (not the 100+ near-duplicate OFAT " +
      "child entries). Use min_ofat_count to find process-development campaigns.",
    inputSchema: QueryElnCanonicalReactionsIn,
    outputSchema: QueryElnCanonicalReactionsOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      const parsed = QueryElnCanonicalReactionsIn.parse(input);
      const result = await postJson(
        `${base}/reactions/query`,
        parsed,
        QueryElnCanonicalReactionsOut,
        TIMEOUT_MS,
        "mcp-eln-local",
      );
      return QueryElnCanonicalReactionsOut.parse(result);
    },
  });
}
