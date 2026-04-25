// query_eln_experiments — Phase F.2 builtin.
//
// Queries ELN notebook entries from Benchling via mcp-eln-benchling.
// Results are scoped to the user's accessible projects (RLS-enforced by
// passing userEntraId to the MCP adapter in the request context).
// Each result surfaces as a Citation with source_kind="external_url".

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";
import type { Citation } from "../../core/types.js";

// ---------- Schemas ----------------------------------------------------------

export const QueryElnExperimentsIn = z.object({
  project_id: z.string().max(200).optional(),
  schema_id: z.string().max(200).optional(),
  since: z.string().max(50).optional().describe("ISO-8601 timestamp; filter entries modified after this time."),
  limit: z.number().int().min(1).max(200).default(20),
});
export type QueryElnExperimentsInput = z.infer<typeof QueryElnExperimentsIn>;

export const ElnExperimentEntry = z.object({
  id: z.string(),
  schema_id: z.string(),
  fields: z.record(z.unknown()),
  attached_files: z.array(z.object({
    document_id: z.string(),
    original_uri: z.string(),
  })).default([]),
  created_at: z.string().nullable().optional(),
  modified_at: z.string().nullable().optional(),
  citation: z.custom<Citation>().optional(),
});

export const QueryElnExperimentsOut = z.object({
  entries: z.array(ElnExperimentEntry),
  next_page_token: z.string().nullable().optional(),
  source_system: z.literal("benchling"),
});
export type QueryElnExperimentsOutput = z.infer<typeof QueryElnExperimentsOut>;

// ---------- Timeout ----------------------------------------------------------

const TIMEOUT_MS = 20_000;

// ---------- Citation builder -------------------------------------------------

function buildCitation(entry: z.infer<typeof ElnExperimentEntry>, benchlingBase: string): Citation {
  return {
    source_id: entry.id,
    source_kind: "external_url",
    source_uri: `${benchlingBase}/entries/${entry.id}`,
    snippet: `Benchling ELN entry ${entry.id}`,
  };
}

// ---------- Factory ----------------------------------------------------------

export function buildQueryElnExperimentsTool(
  pool: Pool,
  mcpElnBenchlingUrl: string,
  benchlingBase: string = "https://app.benchling.com",
) {
  const base = mcpElnBenchlingUrl.replace(/\/$/, "");

  return defineTool({
    id: "query_eln_experiments",
    description:
      "Query ELN notebook entries from Benchling. Returns a list of experiment entries " +
      "with their fields and attached file references. Use when looking up ELN data " +
      "for a specific project, schema, or time range.",
    inputSchema: QueryElnExperimentsIn,
    outputSchema: QueryElnExperimentsOut,

    execute: async (ctx, input) => {
      const raw = await postJson(
        `${base}/query_runs`,
        {
          project_id: input.project_id ?? null,
          schema_id: input.schema_id ?? null,
          since: input.since ?? null,
          limit: input.limit,
        },
        z.unknown(),
        TIMEOUT_MS,
        "mcp-eln-benchling",
      );

      const entries: z.infer<typeof ElnExperimentEntry>[] = (
        (raw as { entries?: unknown[] }).entries ?? []
      ).map((e) => {
        const entry = e as z.infer<typeof ElnExperimentEntry>;
        return {
          ...entry,
          citation: buildCitation(entry, benchlingBase),
        };
      });

      return {
        entries,
        next_page_token: (raw as { next_page_token?: string | null }).next_page_token ?? null,
        source_system: "benchling" as const,
      };
    },
  });
}
