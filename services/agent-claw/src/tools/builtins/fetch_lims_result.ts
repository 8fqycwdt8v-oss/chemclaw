// fetch_lims_result — Phase F.2 builtin.
//
// Fetches a single LIMS test result by STARLIMS result ID.
// Returns structured result data with a Citation.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import type { Citation } from "../../core/types.js";

// ---------- Schemas ----------------------------------------------------------

export const FetchLimsResultIn = z.object({
  result_id: z.string().min(1).max(200).describe("STARLIMS result ID."),
});
export type FetchLimsResultInput = z.infer<typeof FetchLimsResultIn>;

export const FetchLimsResultOut = z.object({
  id: z.string(),
  sample_id: z.string().nullable().optional(),
  method_id: z.string().nullable().optional(),
  analysis_name: z.string().nullable().optional(),
  result_value: z.string().nullable().optional(),
  result_unit: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  analyst: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  citation: z.custom<Citation>(),
  source_system: z.literal("starlims"),
});
export type FetchLimsResultOutput = z.infer<typeof FetchLimsResultOut>;

// ---------- Timeout ----------------------------------------------------------

const TIMEOUT_MS = 20_000;

// ---------- Factory ----------------------------------------------------------

export function buildFetchLimsResultTool(
  pool: Pool,
  mcpLimsStarlimsUrl: string,
  limsBase: string = "https://your-starlims-host",
) {
  const base = mcpLimsStarlimsUrl.replace(/\/$/, "");

  return defineTool({
    id: "fetch_lims_result",
    description:
      "Fetch a single LIMS test result from STARLIMS by result ID. Returns full analytical " +
      "result detail including method, value, unit, and analyst. Use after query_lims_results " +
      "to retrieve a specific result.",
    inputSchema: FetchLimsResultIn,
    outputSchema: FetchLimsResultOut,

    execute: async (ctx, input) => {
      const resp = await fetch(`${base}/test_results/${encodeURIComponent(input.result_id)}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!resp.ok) {
        const detail = await resp.text().catch(() => resp.statusText);
        throw new Error(`mcp-lims-starlims GET /test_results/${input.result_id} → ${resp.status}: ${detail}`);
      }

      const raw = (await resp.json()) as FetchLimsResultOutput;

      const citation: Citation = {
        source_id: raw.id,
        source_kind: "external_url",
        source_uri: `${limsBase}/results/${raw.id}`,
        snippet: `STARLIMS result ${raw.id}${raw.analysis_name ? ` (${raw.analysis_name})` : ""}`,
      };

      return {
        ...raw,
        citation,
        source_system: "starlims" as const,
      };
    },
  });
}
