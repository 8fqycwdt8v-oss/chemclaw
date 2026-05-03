// run_xtb_workflow — wraps mcp-xtb /run_workflow.
//
// Generic multi-step xtb runner. The recipe library lives server-side in
// services/mcp_tools/mcp_xtb/recipes/; the agent picks one by name and supplies
// the recipe-specific inputs as a JSON object. Per-step timing, warnings, and
// success/failure are returned in the response so the agent can reason about
// partial failures without losing context.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";

// ---------- Recipes ---------------------------------------------------------

// Keep this list in sync with services/mcp_tools/mcp_xtb/recipes/__init__.py.
// Encoded as a Zod enum so a typo in the agent's tool call fails locally
// rather than burning a network round-trip on a 400.
export const XTB_RECIPES = [
  "optimize_ensemble",
  "reaction_energy",
] as const;
export type XtbRecipe = (typeof XTB_RECIPES)[number];

// ---------- Schemas ---------------------------------------------------------

export const RunXtbWorkflowIn = z.object({
  recipe: z.enum(XTB_RECIPES).describe(
    "Named recipe defined server-side. " +
    "optimize_ensemble: CREST + per-conformer xtb opt + Boltzmann re-weight (inputs: {smiles, n_conformers?, method?}). " +
    "reaction_energy: opt(reactant) + opt(product) → ΔE in hartree and kcal/mol (inputs: {reactant_smiles, product_smiles, method?}).",
  ),
  inputs: z.record(z.string(), z.unknown()).describe(
    "Recipe-specific inputs as a JSON object. See the recipe description for required keys.",
  ),
  total_timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(1800)
    .nullable()
    .optional()
    .describe(
      "Cap the total wall-clock budget for this run. Server enforces a 1800 s ceiling regardless.",
    ),
});
export type RunXtbWorkflowInput = z.infer<typeof RunXtbWorkflowIn>;

const StepReport = z.object({
  name: z.string(),
  seconds: z.number(),
  ok: z.boolean(),
  error: z.string().nullable().optional(),
});

export const RunXtbWorkflowOut = z.object({
  recipe: z.string(),
  success: z.boolean(),
  steps: z.array(StepReport),
  outputs: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
  total_seconds: z.number(),
});
export type RunXtbWorkflowOutput = z.infer<typeof RunXtbWorkflowOut>;

// ---------- Timeout ---------------------------------------------------------

// Server-side hard ceiling is 1800 s; absolute network cap is 1830 s so
// the server's own timeout enforcement fires first and we get a structured
// response with per-step timings rather than a bare TS abort. When the
// caller supplies total_timeout_seconds, scale the network timeout down
// so a 60-second-budget request doesn't sit idle for 30 minutes.
const SERVER_CEILING_S = 1800;
const NETWORK_SLACK_S = 30;
const ABSOLUTE_TIMEOUT_MS = (SERVER_CEILING_S + NETWORK_SLACK_S) * 1000;

function networkTimeoutMs(requestedSeconds: number | null | undefined): number {
  if (requestedSeconds == null) return ABSOLUTE_TIMEOUT_MS;
  return Math.min(ABSOLUTE_TIMEOUT_MS, (requestedSeconds + NETWORK_SLACK_S) * 1000);
}

// ---------- Factory ---------------------------------------------------------

export function buildRunXtbWorkflowTool(mcpXtbUrl: string) {
  const base = mcpXtbUrl.replace(/\/$/, "");

  return defineTool({
    id: "run_xtb_workflow",
    description:
      "Run a named multi-step xtb recipe (optimize_ensemble, reaction_energy). " +
      "Returns per-step timings + recipe outputs. Recipes are server-side; " +
      "see the `recipe` enum description for inputs.",
    inputSchema: RunXtbWorkflowIn,
    outputSchema: RunXtbWorkflowOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      return await postJson(
        `${base}/run_workflow`,
        input,
        RunXtbWorkflowOut,
        networkTimeoutMs(input.total_timeout_seconds),
        "mcp-xtb",
      );
    },
  });
}
