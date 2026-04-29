// query_instrument_runs — wraps mcp-logs-sciy /datasets/query.
//
// Tool name matches /^query_instrument_/ so the source-cache post-tool hook
// fires automatically and caches the returned facts as :Fact nodes via the
// kg_source_cache projector.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { InstrumentKindEnum, LogsDataset } from "./_logs_schemas.js";

export const QueryInstrumentRunsIn = z.object({
  instrument_kind: z
    .array(InstrumentKindEnum)
    .min(1)
    .max(6)
    .optional()
    .describe(
      "Filter by instrument family (HPLC, NMR, MS, GC-MS, LC-MS, IR). Omit to include all.",
    ),
  since: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe("ISO-8601 lower bound on measured_at."),
  project_code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional()
    .describe("Project code filter — matches mock_eln.projects.code."),
  sample_name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Partial-match filter on the dataset's sample_name."),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe("Opaque cursor returned by a previous call for keyset pagination."),
});
export type QueryInstrumentRunsInput = z.infer<typeof QueryInstrumentRunsIn>;

export const QueryInstrumentRunsOut = z.object({
  datasets: z.array(LogsDataset),
  next_cursor: z.string().nullable().optional(),
  valid_until: z.string(),
});
export type QueryInstrumentRunsOutput = z.infer<typeof QueryInstrumentRunsOut>;

const TIMEOUT_MS = 20_000;

export function buildQueryInstrumentRunsTool(mcpLogsSciyUrl: string) {
  const base = mcpLogsSciyUrl.replace(/\/$/, "");

  return defineTool({
    id: "query_instrument_runs",
    description:
      "Search analytical instrument runs (HPLC / NMR / MS / etc.) recorded in LOGS-by-SciY. " +
      "Filter by instrument_kind, ISO-8601 since, project_code, or partial sample_name. " +
      "Returns up to limit datasets with a cursor for keyset pagination on (measured_at DESC, uid).",
    inputSchema: QueryInstrumentRunsIn,
    outputSchema: QueryInstrumentRunsOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      return postJson(
        `${base}/datasets/query`,
        input,
        QueryInstrumentRunsOut,
        TIMEOUT_MS,
        "mcp-logs-sciy",
      );
    },
  });
}
