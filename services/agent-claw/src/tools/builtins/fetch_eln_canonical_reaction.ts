// fetch_eln_canonical_reaction — wraps mcp-eln-local POST /reactions/fetch.
//
// Returns one canonical reaction plus the top-N child OFAT entries sorted
// by yield (descending). Use after query_eln_canonical_reactions to inspect
// the actual condition variations explored in a process-development campaign.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import {
  CanonicalReactionDetailSchema,
  type CanonicalReactionDetail,
} from "./_eln_shared.js";

export const FetchElnCanonicalReactionIn = z.object({
  reaction_id: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^[A-Za-z0-9_\-\.:]+$/,
      "reaction_id must match [A-Za-z0-9_-.:]+",
    ),
  top_n_ofat: z.number().int().min(0).max(200).default(10),
});
export type FetchElnCanonicalReactionInput = z.infer<
  typeof FetchElnCanonicalReactionIn
>;

export const FetchElnCanonicalReactionOut = CanonicalReactionDetailSchema;
export type FetchElnCanonicalReactionOutput = CanonicalReactionDetail;

const TIMEOUT_MS = 30_000;

export function buildFetchElnCanonicalReactionTool(mcpUrl: string) {
  const base = mcpUrl.replace(/\/$/, "");

  return defineTool({
    id: "fetch_eln_canonical_reaction",
    description:
      "Fetch one canonical reaction from the local mock ELN plus its top-N OFAT " +
      "child entries (sorted by yield descending). Use this after " +
      "query_eln_canonical_reactions to inspect the conditions explored.",
    inputSchema: FetchElnCanonicalReactionIn,
    outputSchema: FetchElnCanonicalReactionOut,

    execute: async (_ctx, input) => {
      const parsed = FetchElnCanonicalReactionIn.parse(input);
      const result = await postJson(
        `${base}/reactions/fetch`,
        parsed,
        FetchElnCanonicalReactionOut,
        TIMEOUT_MS,
        "mcp-eln-local",
      );
      return FetchElnCanonicalReactionOut.parse(result);
    },
  });
}
