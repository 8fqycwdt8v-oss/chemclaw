// query_instrument_runs — Phase F.2 builtin.
//
// Queries HPLC runs from Waters Empower via mcp-instrument-waters.
// Each run surfaces as a Citation with source_kind="external_url".
// The adapter pattern generalises to other vendors via the template.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import type { Citation } from "../../core/types.js";

// ---------- Schemas ----------------------------------------------------------

export const QueryInstrumentRunsIn = z.object({
  sample_name: z.string().max(500).optional().describe("Filter by sample name (partial match)."),
  method_name: z.string().max(500).optional().describe("Filter by chromatographic method name."),
  date_from: z.string().max(50).optional().describe("ISO-8601 date; runs on or after this date."),
  date_to: z.string().max(50).optional().describe("ISO-8601 date; runs on or before this date."),
  limit: z.number().int().min(1).max(500).default(20),
});
export type QueryInstrumentRunsInput = z.infer<typeof QueryInstrumentRunsIn>;

export const ChromatographicPeak = z.object({
  peak_name: z.string().nullable().optional(),
  retention_time_min: z.number(),
  area: z.number(),
  height: z.number().nullable().optional(),
  area_pct: z.number().nullable().optional(),
  resolution: z.number().nullable().optional(),
});

export const HplcRun = z.object({
  id: z.string(),
  sample_name: z.string().nullable().optional(),
  method_name: z.string().nullable().optional(),
  instrument_name: z.string().nullable().optional(),
  run_date: z.string().nullable().optional(),
  peaks: z.array(ChromatographicPeak).default([]),
  total_area: z.number().nullable().optional(),
  citation: z.custom<Citation>().optional(),
});

export const QueryInstrumentRunsOut = z.object({
  runs: z.array(HplcRun),
  total_count: z.number().nullable().optional(),
  source_system: z.literal("waters"),
});
export type QueryInstrumentRunsOutput = z.infer<typeof QueryInstrumentRunsOut>;

// ---------- Timeout ----------------------------------------------------------

const TIMEOUT_MS = 25_000; // HPLC APIs can be slow

// ---------- Citation builder -------------------------------------------------

function buildCitation(run: z.infer<typeof HplcRun>, empowerBase: string): Citation {
  return {
    source_id: run.id,
    source_kind: "external_url",
    source_uri: `${empowerBase}/runs/${run.id}`,
    snippet: `Waters Empower run ${run.id}${run.sample_name ? ` (${run.sample_name})` : ""}`,
  };
}

// ---------- Factory ----------------------------------------------------------

export function buildQueryInstrumentRunsTool(
  pool: Pool,
  mcpInstrumentWatersUrl: string,
  empowerBase: string = "https://your-empower-host",
) {
  const base = mcpInstrumentWatersUrl.replace(/\/$/, "");

  return defineTool({
    id: "query_instrument_runs",
    description:
      "Query HPLC runs from Waters Empower. Returns chromatographic runs with peak data " +
      "filtered by sample name, method, or date range. Use when looking up instrument " +
      "analytical data for a specific sample or batch.",
    inputSchema: QueryInstrumentRunsIn,
    outputSchema: QueryInstrumentRunsOut,

    execute: async (ctx, input) => {
      const raw = await postJson(
        `${base}/search_runs`,
        {
          sample_name: input.sample_name ?? null,
          method_name: input.method_name ?? null,
          date_from: input.date_from ?? null,
          date_to: input.date_to ?? null,
          limit: input.limit,
        },
        z.unknown(),
        TIMEOUT_MS,
        "mcp-instrument-waters",
      );

      const runs: z.infer<typeof HplcRun>[] = (
        (raw as { runs?: unknown[] }).runs ?? []
      ).map((r) => {
        const run = r as z.infer<typeof HplcRun>;
        return {
          ...run,
          citation: buildCitation(run, empowerBase),
        };
      });

      return {
        runs,
        total_count: (raw as { total_count?: number | null }).total_count ?? null,
        source_system: "waters" as const,
      };
    },
  });
}
