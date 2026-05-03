// design_plate — wraps mcp-plate-designer /design_plate.
//
// Phase Z4: BoFire space-filling DoE for HTE plates. Optionally annotates
// each well with predict_yield_with_uq (Z3) when annotate_yield=true.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { MAX_RXN_SMILES_LEN, MAX_SMILES_LEN } from "../_limits.js";

const ContinuousFactor = z.object({
  name: z.string().min(1).max(64),
  type: z.literal("continuous"),
  range: z.tuple([z.number(), z.number()]),
});

const CategoricalInputSpec = z.object({
  name: z.string().min(1).max(64),
  values: z.array(z.string().min(1).max(200)).min(1).max(200),
});

export const DesignPlateIn = z.object({
  plate_format: z.enum(["24", "96", "384", "1536"]),
  reactants_smiles: z.string().min(1).max(MAX_RXN_SMILES_LEN).optional(),
  product_smiles: z.string().min(1).max(MAX_SMILES_LEN).optional(),
  factors: z.array(ContinuousFactor).max(10).default([]),
  categorical_inputs: z.array(CategoricalInputSpec).max(10).default([]),
  exclusions: z
    .object({
      solvents: z.array(z.string()).max(200).default([]),
      reagents: z.array(z.string()).max(200).default([]),
    })
    .default({ solvents: [], reagents: [] }),
  n_wells: z.number().int().min(1).max(1536),
  seed: z.number().int().default(42),
  annotate_yield: z.boolean().default(false),
  project_internal_id: z.string().max(200).optional(),
  disable_chem21_floor: z.boolean().default(false),
});
export type DesignPlateInput = z.infer<typeof DesignPlateIn>;

const Well = z.object({
  well_id: z.string(),
  rxn_smiles: z.string().nullable(),
  factor_values: z.record(z.unknown()),
});

const PlateOut = z.object({
  wells: z.array(Well),
  domain_json: z.record(z.unknown()),
  design_metadata: z.record(z.unknown()),
});

const YieldPrediction = z.object({
  predictions: z.array(
    z.object({
      rxn_smiles: z.string(),
      ensemble_mean: z.number(),
      ensemble_std: z.number(),
      components: z.object({
        chemprop_mean: z.number(),
        chemprop_std: z.number(),
        xgboost_mean: z.number(),
      }),
      used_global_fallback: z.boolean(),
      model_id: z.string().nullable(),
    }),
  ),
});

export const DesignPlateOut = PlateOut.extend({
  yield_summary: z
    .object({
      ensemble_mean: z.number(),
      ensemble_std: z.number(),
      used_global_fallback: z.boolean(),
    })
    .nullable(),
});
export type DesignPlateOutput = z.infer<typeof DesignPlateOut>;

const TIMEOUT_MS = 60_000;

export function buildDesignPlateTool(
  mcpPlateDesignerUrl: string,
  mcpYieldBaselineUrl: string,
) {
  const plateBase = mcpPlateDesignerUrl.replace(/\/$/, "");
  const yieldBase = mcpYieldBaselineUrl.replace(/\/$/, "");

  return defineTool({
    id: "design_plate",
    description:
      "Design an HTE plate (24/96/384/1536) via BoFire space-filling DoE. " +
      "Excluded solvents are dropped from the categorical input; the CHEM21 " +
      "safety floor auto-drops HighlyHazardous solvents (override with " +
      "disable_chem21_floor). Optionally annotates each well with " +
      "predict_yield_with_uq (Z3) when annotate_yield=true.",
    inputSchema: DesignPlateIn,
    outputSchema: DesignPlateOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      const plate = await postJson(
        `${plateBase}/design_plate`,
        {
          plate_format: input.plate_format,
          reactants_smiles: input.reactants_smiles,
          product_smiles: input.product_smiles,
          factors: input.factors,
          categorical_inputs: input.categorical_inputs,
          exclusions: input.exclusions,
          n_wells: input.n_wells,
          seed: input.seed,
          disable_chem21_floor: input.disable_chem21_floor,
        },
        PlateOut,
        TIMEOUT_MS,
        "mcp-plate-designer",
      );

      let yieldSummary: DesignPlateOutput["yield_summary"] = null;

      // Optional yield annotation. The same rxn_smiles repeats across all wells
      // (conditions vary, reactants don't), so we only call yield once per
      // unique reaction and broadcast.
      if (input.annotate_yield && input.reactants_smiles && input.product_smiles) {
        const uniqueRxn = `${input.reactants_smiles}>>${input.product_smiles}`;
        try {
          const pred = await postJson(
            `${yieldBase}/predict_yield_with_uq`,
            {
              rxn_smiles_list: [uniqueRxn],
              project_internal_id: input.project_internal_id,
            },
            YieldPrediction,
            TIMEOUT_MS,
            "mcp-yield-baseline",
          );
          const p = pred.predictions[0];
          if (p) {
            yieldSummary = {
              ensemble_mean: p.ensemble_mean,
              ensemble_std: p.ensemble_std,
              used_global_fallback: p.used_global_fallback,
            };
          }
        } catch {
          // Yield enrichment is best-effort. Plate design is the load-bearing output.
          yieldSummary = null;
        }
      }

      return DesignPlateOut.parse({
        ...plate,
        yield_summary: yieldSummary,
      });
    },
  });
}
