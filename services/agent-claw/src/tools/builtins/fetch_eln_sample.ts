// fetch_eln_sample — wraps mcp-eln-local POST /samples/fetch.
//
// Returns one sample with all linked analytical results. Use this when
// chasing analytical purity / yield evidence from a specific isolated
// sample (the bridge between mock_eln.entries and downstream analytical
// data in fake_logs).

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { SampleSchema, type Sample } from "./_eln_shared.js";

export const FetchElnSampleIn = z.object({
  sample_id: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^[A-Za-z0-9_\-\.:]+$/,
      "sample_id must match [A-Za-z0-9_-.:]+",
    ),
});
export type FetchElnSampleInput = z.infer<typeof FetchElnSampleIn>;

export const FetchElnSampleOut = SampleSchema;
export type FetchElnSampleOutput = Sample;

const TIMEOUT_MS = 15_000;

export function buildFetchElnSampleTool(mcpUrl: string) {
  const base = mcpUrl.replace(/\/$/, "");

  return defineTool({
    id: "fetch_eln_sample",
    description:
      "Fetch one ELN sample (isolated material) with all linked analytical " +
      "results from the local mock ELN. Use after fetch_eln_entry to bridge " +
      "from an experiment into downstream analytical data.",
    inputSchema: FetchElnSampleIn,
    outputSchema: FetchElnSampleOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      const parsed = FetchElnSampleIn.parse(input);
      const result = await postJson(
        `${base}/samples/fetch`,
        parsed,
        FetchElnSampleOut,
        TIMEOUT_MS,
        "mcp-eln-local",
      );
      return FetchElnSampleOut.parse(result);
    },
  });
}
