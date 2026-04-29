// propose_retrosynthesis — wraps mcp-askcos with mcp-aizynth as fallback.
//
// Attempts ASKCOS retrosynthesis first. If ASKCOS times out or returns a
// 503 (model not loaded), falls back to AiZynthFinder.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson, UpstreamError } from "../../mcp/postJson.js";

// ---------- Schemas ----------------------------------------------------------

export const ProposeRetrosynthesisIn = z.object({
  smiles: z.string().min(1).max(10_000),
  max_depth: z.number().int().min(1).max(6).default(3),
  max_branches: z.number().int().min(1).max(10).default(4),
  prefer_aizynth: z.boolean().default(false).describe(
    "If true, skip ASKCOS and go directly to AiZynthFinder.",
  ),
});
export type ProposeRetrosynthesisInput = z.infer<typeof ProposeRetrosynthesisIn>;

const RetroStep = z.object({
  reaction_smiles: z.string(),
  score: z.number(),
  sources_count: z.number().int().nonnegative(),
});

const AskcosRoute = z.object({
  steps: z.array(RetroStep),
  total_score: z.number(),
  depth: z.number().int().positive(),
});

const AskcosOut = z.object({ routes: z.array(AskcosRoute) });

const AiZynthRoute = z.object({
  tree: z.record(z.unknown()),
  score: z.number(),
  in_stock_ratio: z.number(),
});

const AiZynthOut = z.object({ routes: z.array(AiZynthRoute) });

export const ProposeRetrosynthesisOut = z.object({
  source: z.enum(["askcos", "aizynth"]),
  routes_askcos: z.array(AskcosRoute).optional(),
  routes_aizynth: z.array(AiZynthRoute).optional(),
  fallback_reason: z.string().optional(),
});
export type ProposeRetrosynthesisOutput = z.infer<typeof ProposeRetrosynthesisOut>;

// ---------- Timeouts ---------------------------------------------------------

const TIMEOUT_ASKCOS_MS = 30_000;
const TIMEOUT_AIZYNTH_MS = 60_000;

// ---------- Factory ----------------------------------------------------------

export function buildProposeRetrosynthesisTool(
  mcpAskcosUrl: string,
  mcpAiZynthUrl: string,
) {
  const askcosBase = mcpAskcosUrl.replace(/\/$/, "");
  const aizynthBase = mcpAiZynthUrl.replace(/\/$/, "");

  return defineTool({
    id: "propose_retrosynthesis",
    description:
      "Propose multi-step retrosynthesis routes for a target SMILES. " +
      "Uses ASKCOS v2 by default; falls back to AiZynthFinder when ASKCOS times out or is unavailable. " +
      "Returns ranked routes with step-level scores.",
    inputSchema: ProposeRetrosynthesisIn,
    outputSchema: ProposeRetrosynthesisOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      // Optionally skip ASKCOS.
      if (!input.prefer_aizynth) {
        try {
          const result = await postJson(
            `${askcosBase}/retrosynthesis`,
            {
              smiles: input.smiles,
              max_depth: input.max_depth,
              max_branches: input.max_branches,
            },
            AskcosOut,
            TIMEOUT_ASKCOS_MS,
            "mcp-askcos",
          );
          return ProposeRetrosynthesisOut.parse({
            source: "askcos",
            routes_askcos: result.routes,
          });
        } catch (err) {
          const isTimeout = err instanceof Error && err.name === "AbortError";
          const is503 =
            err instanceof UpstreamError && (err.status === 503 || err.status === 503);
          if (!isTimeout && !is503) throw err;
          // Fall through to AiZynth.
          const fallbackReason = isTimeout
            ? "askcos timed out"
            : `askcos returned ${(err as UpstreamError).status}`;
          const aiResult = await postJson(
            `${aizynthBase}/retrosynthesis`,
            {
              smiles: input.smiles,
              max_iterations: 100,
            },
            AiZynthOut,
            TIMEOUT_AIZYNTH_MS,
            "mcp-aizynth",
          );
          return ProposeRetrosynthesisOut.parse({
            source: "aizynth",
            routes_aizynth: aiResult.routes,
            fallback_reason: fallbackReason,
          });
        }
      }

      // Prefer AiZynth explicitly.
      const aiResult = await postJson(
        `${aizynthBase}/retrosynthesis`,
        { smiles: input.smiles, max_iterations: 100 },
        AiZynthOut,
        TIMEOUT_AIZYNTH_MS,
        "mcp-aizynth",
      );
      return ProposeRetrosynthesisOut.parse({
        source: "aizynth",
        routes_aizynth: aiResult.routes,
      });
    },
  });
}
