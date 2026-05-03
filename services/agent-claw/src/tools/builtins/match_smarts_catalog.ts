// match_smarts_catalog — classify a SMILES against the curated SMARTS catalog.
//
// Uses the substructure_match endpoint of mcp-rdkit and walks every enabled
// catalog row. Returns the role + family for each matching rule. Use this
// when you want to ask "what is this compound, structurally?" without going
// through the full Phase 4 classifier projector.

import { z } from "zod";
import type { Pool } from "pg";

import { defineTool } from "../tool.js";
import { withSystemContext } from "../../db/with-user-context.js";
import { postJson } from "../../mcp/postJson.js";
import { getLogger } from "../../observability/logger.js";

const log = getLogger("match_smarts_catalog");

export const MatchSmartsCatalogIn = z.object({
  smiles: z.string().min(1).max(10_000),
  role: z.string().optional().describe(
    "Optional role filter (ligand|catalyst|reagent|solvent|...). When set, " +
      "only catalog rules with that role are evaluated.",
  ),
});
export type MatchSmartsCatalogInput = z.infer<typeof MatchSmartsCatalogIn>;

export const MatchSmartsCatalogOut = z.object({
  smiles: z.string(),
  matches: z.array(
    z.object({
      name: z.string(),
      role: z.string().nullable(),
      family: z.string().nullable(),
      smarts: z.string(),
      n_matches: z.number().int(),
      description: z.string().nullable(),
    }),
  ),
});
export type MatchSmartsCatalogOutput = z.infer<typeof MatchSmartsCatalogOut>;

const SubstructResp = z.object({ matches: z.array(z.array(z.number())), count: z.number() });

const TIMEOUT_MS = 30_000;

export function buildMatchSmartsCatalogTool(pool: Pool, mcpRdkitUrl: string) {
  const base = mcpRdkitUrl.replace(/\/$/, "");
  return defineTool({
    id: "match_smarts_catalog",
    description:
      "Classify a SMILES against the curated SMARTS catalog (phosphines, NHCs, " +
      "primary/secondary amines, aryl halides, boronic acids, polar aprotic " +
      "solvents, …). Returns every catalog rule that matches the molecule with " +
      "its role and family.",
    inputSchema: MatchSmartsCatalogIn,
    outputSchema: MatchSmartsCatalogOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      const rules = await withSystemContext(pool, async (client) => {
        const res = await client.query<{
          name: string;
          smarts: string;
          role: string | null;
          family: string | null;
          description: string | null;
        }>(
          `SELECT name, smarts, role, family, description
             FROM compound_smarts_catalog
            WHERE enabled = TRUE
              AND ($1::text IS NULL OR role = $1::text)
            ORDER BY priority, name`,
          [input.role ?? null],
        );
        return res.rows;
      });

      const matches: MatchSmartsCatalogOutput["matches"] = [];
      for (const rule of rules) {
        try {
          const r = await postJson(
            `${base}/tools/substructure_match`,
            { query_smarts: rule.smarts, target_smiles: input.smiles },
            SubstructResp,
            TIMEOUT_MS,
            "mcp-rdkit",
          );
          if (r.count > 0) {
            matches.push({
              name: rule.name,
              role: rule.role,
              family: rule.family,
              smarts: rule.smarts,
              n_matches: r.count,
              description: rule.description,
            });
          }
        } catch (err) {
          log.warn(
            { event: "smarts_catalog_rule_failed", name: rule.name },
            "skipping catalog rule on error",
          );
        }
      }
      return { smiles: input.smiles, matches };
    },
  });
}
