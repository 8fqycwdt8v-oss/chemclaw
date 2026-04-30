// query_eln_samples_by_entry — wraps mcp-eln-local POST /samples/by_entry.
//
// Returns every sample (isolated material) linked to one ELN entry. The
// previous tool set forced the agent to know sample IDs upfront — that
// blocked the natural cross-source path:
//
//   query_eln_canonical_reactions   → finds reactions
//   fetch_eln_canonical_reaction    → top OFAT children (entry IDs)
//   query_eln_samples_by_entry      → samples for that entry  ← this tool
//   query_instrument_datasets       → analytical data via sample_id
//
// Surface tagged with the regex prefix `query_eln_` so the source-cache
// post-tool hook fires automatically.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { SampleSchema } from "./_eln_shared.js";

export const QueryElnSamplesByEntryIn = z.object({
  entry_id: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^[A-Za-z0-9_\-\.:]+$/,
      "entry_id must match [A-Za-z0-9_-.:]+",
    ),
});
export type QueryElnSamplesByEntryInput = z.infer<typeof QueryElnSamplesByEntryIn>;

export const QueryElnSamplesByEntryOut = z.object({
  entry_id: z.string(),
  samples: z.array(SampleSchema),
});
export type QueryElnSamplesByEntryOutput = z.infer<typeof QueryElnSamplesByEntryOut>;

const TIMEOUT_MS = 15_000;

export function buildQueryElnSamplesByEntryTool(mcpUrl: string) {
  const base = mcpUrl.replace(/\/$/, "");

  return defineTool({
    id: "query_eln_samples_by_entry",
    description:
      "List every sample linked to one ELN entry. Use after fetch_eln_entry " +
      "or fetch_eln_canonical_reaction (which return entry IDs) to enumerate " +
      "samples before crossing into analytical data via query_instrument_datasets.",
    inputSchema: QueryElnSamplesByEntryIn,
    outputSchema: QueryElnSamplesByEntryOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      const parsed = QueryElnSamplesByEntryIn.parse(input);
      const result = await postJson(
        `${base}/samples/by_entry`,
        parsed,
        QueryElnSamplesByEntryOut,
        TIMEOUT_MS,
        "mcp-eln-local",
      );
      return QueryElnSamplesByEntryOut.parse(result);
    },
  });
}
