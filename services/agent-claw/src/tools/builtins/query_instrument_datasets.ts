// query_instrument_datasets — wraps mcp-logs-sciy /datasets/by_sample.
//
// Tool name matches /^query_instrument_/ so the source-cache post-tool hook
// fires automatically. The "datasets" suffix distinguishes the
// sample-id-driven join from the broader query in query_instrument_runs.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { LogsDataset } from "./_logs_schemas.js";

export const QueryInstrumentDatasetsIn = z.object({
  sample_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.-]+$/)
    .describe("Sample identifier — matches mock_eln.samples.sample_code."),
});
export type QueryInstrumentDatasetsInput = z.infer<typeof QueryInstrumentDatasetsIn>;

export const QueryInstrumentDatasetsOut = z.object({
  datasets: z.array(LogsDataset),
  valid_until: z.string(),
});
export type QueryInstrumentDatasetsOutput = z.infer<typeof QueryInstrumentDatasetsOut>;

const TIMEOUT_MS = 20_000;

export function buildQueryInstrumentDatasetsTool(mcpLogsSciyUrl: string) {
  const base = mcpLogsSciyUrl.replace(/\/$/, "");

  return defineTool({
    id: "query_instrument_datasets",
    description:
      "Find all LOGS-by-SciY analytical datasets recorded for a given sample_id. " +
      "Use after fetching an ELN sample to gather every HPLC / NMR / MS run that " +
      "shares the sample identifier.",
    inputSchema: QueryInstrumentDatasetsIn,
    outputSchema: QueryInstrumentDatasetsOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      return await postJson(
        `${base}/datasets/by_sample`,
        { sample_id: input.sample_id },
        QueryInstrumentDatasetsOut,
        TIMEOUT_MS,
        "mcp-logs-sciy",
      );
    },
  });
}
