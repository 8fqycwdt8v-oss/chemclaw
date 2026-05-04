// inchikey_from_smiles — thin wrapper over mcp-rdkit's /tools/inchikey_from_smiles.
//
// Distinct from canonicalize_smiles (which also returns the InChIKey along
// with formula/MW/canonical SMILES) so skill prompts that only need the
// InChIKey can call a cheaper tool. Library-design and QM pipeline planner
// skills declare this as a required tool.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";

export const InchikeyIn = z.object({
  smiles: z.string().min(1).max(10_000),
});
export type InchikeyInput = z.infer<typeof InchikeyIn>;

export const InchikeyOut = z.object({
  inchikey: z.string(),
});
export type InchikeyOutput = z.infer<typeof InchikeyOut>;

const TIMEOUT_MS = 10_000;

export function buildInchikeyFromSmilesTool(mcpRdkitUrl: string) {
  return defineTool({
    id: "inchikey_from_smiles",
    description:
      "Compute the InChIKey for a SMILES string via RDKit. Use this when you need a stable canonical compound identifier without canonical SMILES, formula, or MW.",
    inputSchema: InchikeyIn,
    outputSchema: InchikeyOut,
    annotations: { readOnly: true },
    execute: async (ctx, input) => {
      return await postJson(
        `${mcpRdkitUrl.replace(/\/$/, "")}/tools/inchikey_from_smiles`,
        input,
        InchikeyOut,
        TIMEOUT_MS,
        "mcp-rdkit",
        { userEntraId: ctx.userEntraId },
      );
    },
  });
}
