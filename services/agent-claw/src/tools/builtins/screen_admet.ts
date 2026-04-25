// screen_admet — wraps mcp-admetlab 119-endpoint ADMET screening.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";

// ---------- Schemas ----------------------------------------------------------

export const ScreenAdmetIn = z.object({
  smiles_list: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .describe("List of SMILES to screen (max 50)."),
});
export type ScreenAdmetInput = z.infer<typeof ScreenAdmetIn>;

const AdmetEndpoints = z.object({
  absorption: z.record(z.unknown()).default({}),
  distribution: z.record(z.unknown()).default({}),
  metabolism: z.record(z.unknown()).default({}),
  excretion: z.record(z.unknown()).default({}),
  toxicity: z.record(z.unknown()).default({}),
});

const AdmetPrediction = z.object({
  smiles: z.string(),
  endpoints: AdmetEndpoints,
  alerts: z.array(z.string()).default([]),
});

export const ScreenAdmetOut = z.object({
  predictions: z.array(AdmetPrediction),
});
export type ScreenAdmetOutput = z.infer<typeof ScreenAdmetOut>;

// ---------- Timeout ----------------------------------------------------------

const TIMEOUT_MS = 90_000;

// ---------- Factory ----------------------------------------------------------

export function buildScreenAdmetTool(mcpAdmetlabUrl: string) {
  const base = mcpAdmetlabUrl.replace(/\/$/, "");

  return defineTool({
    id: "screen_admet",
    description:
      "Screen up to 50 compounds for ADMET (absorption, distribution, metabolism, " +
      "excretion, toxicity) liabilities using ADMETlab 3.0. Returns 119 endpoints per compound " +
      "plus structural alerts. Use early in lead selection.",
    inputSchema: ScreenAdmetIn,
    outputSchema: ScreenAdmetOut,

    execute: async (_ctx, input) => {
      return postJson(
        `${base}/screen`,
        { smiles_list: input.smiles_list },
        ScreenAdmetOut,
        TIMEOUT_MS,
        "mcp-admetlab",
      );
    },
  });
}
