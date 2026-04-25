// query_lims_results — Phase F.2 builtin.
//
// Queries LIMS test results from STARLIMS via mcp-lims-starlims.
// Each result surfaces as a Citation with source_kind="external_url".

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import type { Citation } from "../../core/types.js";

// ---------- Schemas ----------------------------------------------------------

export const QueryLimsResultsIn = z.object({
  sample_id: z.string().max(200).optional().describe("Filter by sample ID."),
  method_id: z.string().max(200).optional().describe("Filter by analytical method ID."),
  since: z.string().max(50).optional().describe("ISO-8601 timestamp; return results completed after this time."),
  limit: z.number().int().min(1).max(500).default(20),
});
export type QueryLimsResultsInput = z.infer<typeof QueryLimsResultsIn>;

export const LimsTestResult = z.object({
  id: z.string(),
  sample_id: z.string().nullable().optional(),
  method_id: z.string().nullable().optional(),
  analysis_name: z.string().nullable().optional(),
  result_value: z.string().nullable().optional(),
  result_unit: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  analyst: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  citation: z.custom<Citation>().optional(),
});

export const QueryLimsResultsOut = z.object({
  results: z.array(LimsTestResult),
  total_count: z.number().nullable().optional(),
  source_system: z.literal("starlims"),
});
export type QueryLimsResultsOutput = z.infer<typeof QueryLimsResultsOut>;

// ---------- Timeout ----------------------------------------------------------

const TIMEOUT_MS = 20_000;

// ---------- Citation builder -------------------------------------------------

function buildCitation(result: z.infer<typeof LimsTestResult>, limsBase: string): Citation {
  return {
    source_id: result.id,
    source_kind: "external_url",
    source_uri: `${limsBase}/results/${result.id}`,
    snippet: `STARLIMS result ${result.id}${result.analysis_name ? ` (${result.analysis_name})` : ""}`,
  };
}

// ---------- Factory ----------------------------------------------------------

export function buildQueryLimsResultsTool(
  pool: Pool,
  mcpLimsStarlimsUrl: string,
  limsBase: string = "https://your-starlims-host",
) {
  const base = mcpLimsStarlimsUrl.replace(/\/$/, "");

  return defineTool({
    id: "query_lims_results",
    description:
      "Query LIMS test results from STARLIMS. Returns analytical results (purity, potency, etc.) " +
      "for samples filtered by sample ID, method, or time range. Use when looking up QC/QA data " +
      "for a specific batch or sample.",
    inputSchema: QueryLimsResultsIn,
    outputSchema: QueryLimsResultsOut,

    execute: async (ctx, input) => {
      const raw = await postJson(
        `${base}/query_results`,
        {
          sample_id: input.sample_id ?? null,
          method_id: input.method_id ?? null,
          since: input.since ?? null,
          limit: input.limit,
        },
        z.unknown(),
        TIMEOUT_MS,
        "mcp-lims-starlims",
      );

      const results: z.infer<typeof LimsTestResult>[] = (
        (raw as { results?: unknown[] }).results ?? []
      ).map((r) => {
        const result = r as z.infer<typeof LimsTestResult>;
        return {
          ...result,
          citation: buildCitation(result, limsBase),
        };
      });

      return {
        results,
        total_count: (raw as { total_count?: number | null }).total_count ?? null,
        source_system: "starlims" as const,
      };
    },
  });
}
