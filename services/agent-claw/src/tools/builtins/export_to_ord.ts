// export_to_ord — wraps mcp-ord-io /export.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { MAX_RXN_SMILES_LEN, MAX_SMILES_LEN } from "../_limits.js";

const Well = z.object({
  well_id: z.string(),
  rxn_smiles: z.string().nullable().optional(),
  factor_values: z.record(z.unknown()),
});

export const ExportToOrdIn = z.object({
  plate_name: z.string().min(1).max(200).default("plate"),
  reactants_smiles: z.string().min(1).max(MAX_RXN_SMILES_LEN).optional(),
  product_smiles: z.string().min(1).max(MAX_SMILES_LEN).optional(),
  wells: z.array(Well).min(1).max(2000),
});
export type ExportToOrdInput = z.infer<typeof ExportToOrdIn>;

export const ExportToOrdOut = z.object({
  ord_protobuf_b64: z.string(),
  n_reactions: z.number().int(),
  summary: z.record(z.unknown()),
});
export type ExportToOrdOutput = z.infer<typeof ExportToOrdOut>;

const TIMEOUT_MS = 30_000;

export function buildExportToOrdTool(mcpOrdIoUrl: string) {
  const base = mcpOrdIoUrl.replace(/\/$/, "");
  return defineTool({
    id: "export_to_ord",
    description:
      "Export a plate (or any list of well dicts with factor values) into an " +
      "Open Reaction Database (ORD) Dataset protobuf, base64-encoded. The " +
      "result is a portable format that downstream HTE robotics or LIMS systems " +
      "can consume.",
    inputSchema: ExportToOrdIn,
    outputSchema: ExportToOrdOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      return await postJson(
        `${base}/export`,
        {
          plate_name: input.plate_name,
          reactants_smiles: input.reactants_smiles,
          product_smiles: input.product_smiles,
          wells: input.wells.map((w) => ({
            well_id: w.well_id,
            rxn_smiles: w.rxn_smiles ?? null,
            factor_values: w.factor_values,
          })),
        },
        ExportToOrdOut,
        TIMEOUT_MS,
        "mcp-ord-io",
      );
    },
  });
}
