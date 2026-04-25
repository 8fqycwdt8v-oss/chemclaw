// canonicalize_smiles — first builtin tool.
// Calls mcp-rdkit via postJson; returns RDKit-computed canonical form.
//
// Input is validated by the Tool's inputSchema (Zod) before execute() is called.
// Response is validated by postJson against CanonicalizeOut before returning.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";

// ---------- Schemas ----------------------------------------------------------

export const CanonicalizeIn = z.object({
  smiles: z.string().min(1).max(10_000),
  kekulize: z.boolean().optional(),
});
export type CanonicalizeInput = z.infer<typeof CanonicalizeIn>;

export const CanonicalizeOut = z.object({
  canonical_smiles: z.string(),
  inchikey: z.string(),
  formula: z.string(),
  mw: z.number(),
});
export type CanonicalizeOutput = z.infer<typeof CanonicalizeOut>;

// ---------- Timeout ----------------------------------------------------------

const TIMEOUT_MS = 10_000;

// ---------- Factory ----------------------------------------------------------

/**
 * Build the canonicalize_smiles tool, wiring it to the given mcp-rdkit baseUrl.
 * The baseUrl is read from the mcp_tools table at startup by ToolRegistry.loadFromDb().
 */
export function buildCanonicalizeSmilesTool(mcpRdkitUrl: string) {
  return defineTool({
    id: "canonicalize_smiles",
    description:
      "Canonicalize a SMILES string via RDKit. Returns canonical_smiles, InChIKey, molecular formula, and molecular weight.",
    inputSchema: CanonicalizeIn,
    outputSchema: CanonicalizeOut,
    execute: async (_ctx, input) => {
      return postJson(
        `${mcpRdkitUrl.replace(/\/$/, "")}/tools/canonicalize_smiles`,
        input,
        CanonicalizeOut,
        TIMEOUT_MS,
        "mcp-rdkit",
      );
    },
  });
}
