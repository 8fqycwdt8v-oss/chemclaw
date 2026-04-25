// fetch_instrument_run — Phase F.2 builtin.
//
// Fetches a single HPLC run (with peaks) from Waters Empower by run ID.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { getJson } from "../../mcp/postJson.js";
import type { Citation } from "../../core/types.js";

// ---------- Schemas ----------------------------------------------------------

export const FetchInstrumentRunIn = z.object({
  run_id: z.string().min(1).max(200).describe("Waters Empower run ID."),
});
export type FetchInstrumentRunInput = z.infer<typeof FetchInstrumentRunIn>;

const ChromatographicPeak = z.object({
  peak_name: z.string().nullable().optional(),
  retention_time_min: z.number(),
  area: z.number(),
  height: z.number().nullable().optional(),
  area_pct: z.number().nullable().optional(),
  resolution: z.number().nullable().optional(),
});

const FetchInstrumentRunRaw = z.object({
  id: z.string(),
  sample_name: z.string().nullable().optional(),
  method_name: z.string().nullable().optional(),
  instrument_name: z.string().nullable().optional(),
  run_date: z.string().nullable().optional(),
  peaks: z.array(ChromatographicPeak).default([]),
  total_area: z.number().nullable().optional(),
});

export const FetchInstrumentRunOut = FetchInstrumentRunRaw.extend({
  citation: z.custom<Citation>(),
  source_system: z.literal("waters"),
});
export type FetchInstrumentRunOutput = z.infer<typeof FetchInstrumentRunOut>;

// ---------- Timeout ----------------------------------------------------------

const TIMEOUT_MS = 25_000;

// ---------- Factory ----------------------------------------------------------

export function buildFetchInstrumentRunTool(
  pool: Pool,
  mcpInstrumentWatersUrl: string,
  empowerBase: string = "https://your-empower-host",
) {
  const base = mcpInstrumentWatersUrl.replace(/\/$/, "");

  return defineTool({
    id: "fetch_instrument_run",
    description:
      "Fetch a single HPLC run with peak data from Waters Empower by run ID. Returns full " +
      "chromatographic detail including all detected peaks with retention times, areas, and " +
      "purity percentages. Use after query_instrument_runs to retrieve a specific run.",
    inputSchema: FetchInstrumentRunIn,
    outputSchema: FetchInstrumentRunOut,

    execute: async (ctx, input) => {
      const raw = await getJson(
        `${base}/run/${encodeURIComponent(input.run_id)}`,
        FetchInstrumentRunRaw,
        TIMEOUT_MS,
        "mcp-instrument-waters",
      );

      const citation: Citation = {
        source_id: raw.id,
        source_kind: "external_url",
        source_uri: `${empowerBase}/runs/${raw.id}`,
        snippet: `Waters Empower run ${raw.id}${raw.sample_name ? ` (${raw.sample_name})` : ""}`,
      };

      return {
        ...raw,
        citation,
        source_system: "waters" as const,
      };
    },
  });
}
