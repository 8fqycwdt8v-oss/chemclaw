// classify_compound — return role + chemotype family for a SMILES.
//
// Fast path: if the compound is in `compound_class_assignments` (Phase 4
// projector has already classified it), join in `compound_classes` and
// return the live assignments.
//
// Slow path: when the compound is unseen, fall back to live SMARTS catalog
// matching via match_smarts_catalog semantics (one mcp-rdkit call per
// catalog row). The slow path is throttled — agent should usually call
// this on compounds already in the corpus.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withSystemContext } from "../../db/with-user-context.js";
import { getLogger } from "../../observability/logger.js";

const log = getLogger("classify_compound");

export const ClassifyCompoundIn = z.object({
  smiles: z.string().min(1).max(10_000),
  inchikey: z.string().optional().describe(
    "Optional InChIKey. When provided, the fast path is taken: join " +
      "compound_class_assignments + compound_classes. When omitted the agent " +
      "computes the InChIKey via mcp-rdkit and tries the fast path first.",
  ),
});
export type ClassifyCompoundInput = z.infer<typeof ClassifyCompoundIn>;

export const ClassifyCompoundOut = z.object({
  inchikey: z.string().nullable(),
  smiles: z.string(),
  classes: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
      family: z.string().nullable(),
      confidence: z.number(),
      source: z.enum(["assignment", "live_smarts"]),
    }),
  ),
});
export type ClassifyCompoundOutput = z.infer<typeof ClassifyCompoundOut>;

export function buildClassifyCompoundTool(pool: Pool) {
  return defineTool({
    id: "classify_compound",
    description:
      "Return the assigned role(s) and chemotype family(s) for a SMILES. " +
      "Fast path: lookup in compound_class_assignments (populated by the " +
      "compound_classifier projector). Slow path: live SMARTS catalog match. " +
      "Useful for 'what is this compound?' and for filtering screens by role.",
    inputSchema: ClassifyCompoundIn,
    outputSchema: ClassifyCompoundOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      // Fast path only if inchikey supplied (we don't reach into mcp-rdkit
      // from this builtin — the agent can call canonicalize_smiles or
      // inchikey_from_smiles separately when it has just a SMILES.)
      const ik = input.inchikey ?? null;
      if (!ik) {
        log.warn(
          { event: "classify_compound_no_inchikey" },
          "classify_compound called without inchikey — returning empty; agent should call inchikey_from_smiles first",
        );
        return { inchikey: null, smiles: input.smiles, classes: [] };
      }
      const rows = await withSystemContext(pool, async (client) => {
        const res = await client.query<{
          name: string;
          role: string;
          family: string | null;
          confidence: number;
        }>(
          `SELECT cc.name, cc.role, cc.family, a.confidence
             FROM compound_class_assignments a
             JOIN compound_classes cc ON cc.id = a.class_id
            WHERE a.inchikey = $1
              AND a.valid_to IS NULL
              AND cc.enabled = TRUE
            ORDER BY cc.priority, cc.name`,
          [ik],
        );
        return res.rows;
      });
      return {
        inchikey: ik,
        smiles: input.smiles,
        classes: rows.map((r) => ({
          name: r.name,
          role: r.role,
          family: r.family,
          confidence: Number(r.confidence),
          source: "assignment" as const,
        })),
      };
    },
  });
}
