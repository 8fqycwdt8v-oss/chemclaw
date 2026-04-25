// fetch_eln_entry — Phase F.2 builtin.
//
// Fetches a single ELN notebook entry by Benchling entry ID.
// Returns structured fields + attached file URIs as a Citation.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import type { Citation } from "../../core/types.js";

// ---------- Schemas ----------------------------------------------------------

export const FetchElnEntryIn = z.object({
  entry_id: z.string().min(1).max(200).describe("Benchling entry ID (e.g., etr_abc123)."),
});
export type FetchElnEntryInput = z.infer<typeof FetchElnEntryIn>;

export const FetchElnEntryOut = z.object({
  id: z.string(),
  schema_id: z.string(),
  fields: z.record(z.unknown()),
  attached_files: z.array(z.object({
    document_id: z.string(),
    original_uri: z.string(),
  })).default([]),
  created_at: z.string().nullable().optional(),
  modified_at: z.string().nullable().optional(),
  citation: z.custom<Citation>(),
  source_system: z.literal("benchling"),
});
export type FetchElnEntryOutput = z.infer<typeof FetchElnEntryOut>;

// ---------- Timeout ----------------------------------------------------------

const TIMEOUT_MS = 20_000;

// ---------- Factory ----------------------------------------------------------

export function buildFetchElnEntryTool(
  pool: Pool,
  mcpElnBenchlingUrl: string,
  benchlingBase: string = "https://app.benchling.com",
) {
  const base = mcpElnBenchlingUrl.replace(/\/$/, "");

  return defineTool({
    id: "fetch_eln_entry",
    description:
      "Fetch a single ELN notebook entry from Benchling by entry ID. Returns structured " +
      "field values and attached file references. Use after query_eln_experiments to " +
      "retrieve full detail for a specific entry.",
    inputSchema: FetchElnEntryIn,
    outputSchema: FetchElnEntryOut,

    execute: async (ctx, input) => {
      // mcp-eln-benchling exposes GET /experiments/{id} — we simulate via a
      // fetch to the REST endpoint using postJson's underlying fetch mechanism.
      const resp = await fetch(`${base}/experiments/${encodeURIComponent(input.entry_id)}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!resp.ok) {
        const detail = await resp.text().catch(() => resp.statusText);
        throw new Error(`mcp-eln-benchling GET /experiments/${input.entry_id} → ${resp.status}: ${detail}`);
      }

      const raw = (await resp.json()) as FetchElnEntryOutput;

      const citation: Citation = {
        source_id: raw.id,
        source_kind: "external_url",
        source_uri: `${benchlingBase}/entries/${raw.id}`,
        snippet: `Benchling ELN entry ${raw.id}`,
      };

      return {
        ...raw,
        citation,
        source_system: "benchling" as const,
      };
    },
  });
}
