// fetch_eln_entry — wraps mcp-eln-local POST /experiments/fetch.
//
// Returns one ElnEntry by id with attachments and audit summary populated.
// The post-tool source-cache hook fires automatically on the tool name
// matching /^(query|fetch)_(eln|lims|instrument)_/.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { ElnEntrySchema, type ElnEntry } from "./_eln_shared.js";

export const FetchElnEntryIn = z.object({
  entry_id: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^[A-Za-z0-9_\-\.:]+$/,
      "entry_id must match [A-Za-z0-9_-.:]+",
    ),
});
export type FetchElnEntryInput = z.infer<typeof FetchElnEntryIn>;

export const FetchElnEntryOut = ElnEntrySchema;
export type FetchElnEntryOutput = ElnEntry;

const TIMEOUT_MS = 15_000;

export function buildFetchElnEntryTool(mcpUrl: string) {
  const base = mcpUrl.replace(/\/$/, "");

  return defineTool({
    id: "fetch_eln_entry",
    description:
      "Fetch a single ELN entry by id from the local mock ELN. Returns the full " +
      "fields_jsonb, freetext, attachments metadata, and audit summary. Use after " +
      "query_eln_experiments to drill into a specific run.",
    inputSchema: FetchElnEntryIn,
    outputSchema: FetchElnEntryOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      const parsed = FetchElnEntryIn.parse(input);
      const result = await postJson(
        `${base}/experiments/fetch`,
        parsed,
        FetchElnEntryOut,
        TIMEOUT_MS,
        "mcp-eln-local",
      );
      return FetchElnEntryOut.parse(result);
    },
  });
}
