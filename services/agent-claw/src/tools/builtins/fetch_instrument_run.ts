// fetch_instrument_run — wraps mcp-logs-sciy /datasets/fetch.
//
// Tool name matches /^fetch_instrument_/ so the source-cache post-tool hook
// fires automatically and caches the returned facts.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { LogsDataset } from "./_logs_schemas.js";

export const FetchInstrumentRunIn = z.object({
  uid: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.\-]+$/)
    .describe("LOGS dataset UID."),
});
export type FetchInstrumentRunInput = z.infer<typeof FetchInstrumentRunIn>;

export const FetchInstrumentRunOut = z.object({
  dataset: LogsDataset,
  valid_until: z.string(),
});
export type FetchInstrumentRunOutput = z.infer<typeof FetchInstrumentRunOut>;

const TIMEOUT_MS = 20_000;

export function buildFetchInstrumentRunTool(mcpLogsSciyUrl: string) {
  const base = mcpLogsSciyUrl.replace(/\/$/, "");

  return defineTool({
    id: "fetch_instrument_run",
    description:
      "Fetch a single LOGS-by-SciY analytical dataset by UID. Returns the canonical " +
      "dataset record including parameters and detector tracks.",
    inputSchema: FetchInstrumentRunIn,
    outputSchema: FetchInstrumentRunOut,

    execute: async (_ctx, input) => {
      return postJson(
        `${base}/datasets/fetch`,
        { uid: input.uid },
        FetchInstrumentRunOut,
        TIMEOUT_MS,
        "mcp-logs-sciy",
      );
    },
  });
}
