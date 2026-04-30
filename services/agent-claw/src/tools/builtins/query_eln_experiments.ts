// query_eln_experiments — wraps mcp-eln-local POST /experiments/query.
//
// Tool name matches /^(query|fetch)_(eln|lims|instrument)_/ so the post-tool
// source-cache hook fires automatically and stamps :Fact provenance for any
// numeric ELN fields surfaced in the response.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import {
  ElnEntrySchema,
  type ElnEntry,
} from "./_eln_shared.js";

export const QueryElnExperimentsIn = z.object({
  project_code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/, "project_code must be alphanumeric/.-/_"),
  schema_kind: z.string().max(64).optional(),
  reaction_id: z.string().max(128).optional(),
  since: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe("ISO-8601 lower bound on modified_at."),
  entry_shape: z
    .enum(["mixed", "pure-structured", "pure-freetext"])
    .optional(),
  data_quality_tier: z
    .enum(["clean", "partial", "noisy", "failed"])
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(256).optional(),
});
export type QueryElnExperimentsInput = z.infer<typeof QueryElnExperimentsIn>;

export const QueryElnExperimentsOut = z.object({
  items: z.array(ElnEntrySchema),
  next_cursor: z.string().nullable().optional(),
});
export interface QueryElnExperimentsOutput {
  items: ElnEntry[];
  next_cursor?: string | null;
}

const TIMEOUT_MS = 15_000;

export function buildQueryElnExperimentsTool(mcpUrl: string) {
  const base = mcpUrl.replace(/\/$/, "");

  return defineTool({
    id: "query_eln_experiments",
    description:
      "Query the local mock ELN for experiments by project code, with optional " +
      "filters on schema_kind, reaction_id, modified_at lower bound, entry_shape, " +
      "and data_quality_tier. Returns a keyset-paginated list of ElnEntry rows; " +
      "pass next_cursor back as cursor to continue.",
    inputSchema: QueryElnExperimentsIn,
    outputSchema: QueryElnExperimentsOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      const parsed = QueryElnExperimentsIn.parse(input);
      const result = await postJson(
        `${base}/experiments/query`,
        parsed,
        QueryElnExperimentsOut,
        TIMEOUT_MS,
        "mcp-eln-local",
      );
      return QueryElnExperimentsOut.parse(result);
    },
  });
}
