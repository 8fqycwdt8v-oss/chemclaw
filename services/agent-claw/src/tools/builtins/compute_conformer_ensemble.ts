// compute_conformer_ensemble — convenience shim over run_xtb_workflow.
//
// Calls the `optimize_ensemble` server-side recipe and projects the result
// back to the legacy `{ conformers: [...] }` shape so prompts/skills that
// already reference this tool keep working unchanged. New code should
// prefer `run_xtb_workflow` directly so it has access to per-step timing
// and warnings.
//
// Latency: ~30 s per call (CREST ensemble + per-conformer xtb opt for
// typical drug-like molecules). Suitable for stereo / atropisomerism
// investigations.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { getToolTimeoutMs } from "../../config/tool-timeouts.js";
import { RunXtbWorkflowOut } from "./run_xtb_workflow.js";
import { normalizeUrl } from "../../mcp/normalize-url.js";

// ---------- Schemas ----------------------------------------------------------

export const ComputeConformerEnsembleIn = z.object({
  smiles: z.string().min(1).max(10_000),
  n_conformers: z.number().int().min(1).max(100).default(20).describe(
    "Maximum number of conformers to return from the CREST ensemble.",
  ),
  method: z
    .enum(["GFN2-xTB", "GFN-FF"])
    .default("GFN2-xTB")
    .describe("Semi-empirical method for the per-conformer geometry optimisation."),
});
export type ComputeConformerEnsembleInput = z.infer<typeof ComputeConformerEnsembleIn>;

const ConformerEntry = z.object({
  xyz: z.string(),
  energy_hartree: z.number(),
  weight: z.number(),
});

// The recipe's outputs.conformers shape inside the WorkflowResult body.
// Validated explicitly here so a mismatch surfaces as a recipe-shape
// error at this boundary, not as an opaque outer-Zod failure.
const OptimizeEnsembleOutputs = z.object({
  conformers: z.array(ConformerEntry),
});

export const ComputeConformerEnsembleOut = z.object({
  conformers: z.array(ConformerEntry),
});
export type ComputeConformerEnsembleOutput = z.infer<typeof ComputeConformerEnsembleOut>;

// ---------- Timeout ----------------------------------------------------------

// CREST + per-conformer opt fits comfortably inside the 1800 s server-side
// ceiling for typical molecules; the wider cap matches run_xtb_workflow.
const DEFAULT_TIMEOUT_MS = 1830 * 1000;
const TOOL_ID = "compute_conformer_ensemble";

// ---------- Factory ----------------------------------------------------------

export function buildComputeConformerEnsembleTool(mcpXtbUrl: string) {
  const base = normalizeUrl(mcpXtbUrl);

  return defineTool({
    id: TOOL_ID,
    description:
      "Generate a Boltzmann-weighted conformer ensemble for a SMILES using GFN2-xTB + CREST. " +
      "Use for stereo, atropisomerism, or ring-flip questions. Latency ~30-60 s.",
    inputSchema: ComputeConformerEnsembleIn,
    outputSchema: ComputeConformerEnsembleOut,
    annotations: { readOnly: true },

    execute: async (ctx, input) => {
      const timeoutMs = await getToolTimeoutMs(TOOL_ID, { user: ctx.userEntraId }, DEFAULT_TIMEOUT_MS);
      const result = await postJson(
        `${base}/run_workflow`,
        {
          recipe: "optimize_ensemble",
          inputs: {
            smiles: input.smiles,
            n_conformers: input.n_conformers,
            method: input.method,
          },
        },
        RunXtbWorkflowOut,
        timeoutMs,
        "mcp-xtb",
      );
      if (!result.success) {
        const failed = result.steps.find((s) => !s.ok);
        throw new Error(
          `optimize_ensemble failed at step ${failed?.name ?? "?"}: ${failed?.error ?? "unknown"}`,
        );
      }
      const parsed = OptimizeEnsembleOutputs.safeParse(result.outputs);
      if (!parsed.success) {
        throw new Error(
          `optimize_ensemble returned an unexpected outputs shape: ${parsed.error.issues[0]?.message ?? "?"}`,
        );
      }
      return { conformers: parsed.data.conformers };
    },
  });
}
