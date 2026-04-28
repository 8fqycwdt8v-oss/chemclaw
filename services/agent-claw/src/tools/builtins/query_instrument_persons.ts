// query_instrument_persons — wraps mcp-logs-sciy /persons/query.
//
// Surfaces the LOGS Person directory (operators / analysts / chemists who
// signed off on instrument runs). Useful for attribution when reporting
// analytical results — pairs naturally with `fetch_instrument_run` which
// returns an `operator` username field; this tool resolves the username
// to display_name + email.
//
// Tool id matches /^query_instrument_/ so the source-cache post-tool hook
// fires automatically (the resulting facts are cached as :Person nodes
// once the kg_source_cache projector knows about them — for now they are
// recorded as opaque source facts under the same provenance pipeline).

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";

export const QueryInstrumentPersonsIn = z.object({
  name_contains: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Case-insensitive partial-match filter on display_name. " +
        "Omit to list everyone (capped by `limit`).",
    ),
  limit: z.number().int().min(1).max(200).default(50),
});
export type QueryInstrumentPersonsInput = z.infer<typeof QueryInstrumentPersonsIn>;

const PersonSchema = z.object({
  username: z.string(),
  display_name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
});

export const QueryInstrumentPersonsOut = z.object({
  persons: z.array(PersonSchema),
  valid_until: z.string(),
});
export type QueryInstrumentPersonsOutput = z.infer<typeof QueryInstrumentPersonsOut>;

const TIMEOUT_MS = 15_000;

export function buildQueryInstrumentPersonsTool(mcpLogsSciyUrl: string) {
  const base = mcpLogsSciyUrl.replace(/\/$/, "");

  return defineTool({
    id: "query_instrument_persons",
    description:
      "List operators / analysts known to the analytical SDMS (LOGS) Person " +
      "directory. Use to resolve the `operator` username on a fetched run " +
      "into a display_name + email for citation attribution. Optional " +
      "case-insensitive `name_contains` filter; results capped by `limit`.",
    inputSchema: QueryInstrumentPersonsIn,
    outputSchema: QueryInstrumentPersonsOut,

    execute: async (_ctx, input) => {
      const parsed = QueryInstrumentPersonsIn.parse(input);
      const result = await postJson(
        `${base}/persons/query`,
        parsed,
        QueryInstrumentPersonsOut,
        TIMEOUT_MS,
        "mcp-logs-sciy",
      );
      return QueryInstrumentPersonsOut.parse(result);
    },
  });
}
