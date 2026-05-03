// generate_focused_library — wraps mcp-genchem to propose new structures.
//
// One builtin, one `kind` parameter selecting the underlying generator
// (scaffold | rgroup | bioisostere | grow | link). Returns the run_id
// (gen_runs) and a list of proposals; the agent can then pipe the proposals
// into find_similar_compounds, qm_single_point, or run_chemspace_screen.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";

export const GenerateFocusedLibraryIn = z.object({
  kind: z.enum(["scaffold", "rgroup", "bioisostere", "grow", "link"]).default("scaffold"),
  seed_smiles: z.string().min(1).max(10_000).describe(
    "For scaffold/rgroup: SMILES with [*:N] attachment points. For " +
      "bioisostere/grow: a complete molecule. For link: not used " +
      "(use fragment_a/fragment_b instead).",
  ),
  fragment_a: z.string().min(1).max(10_000).optional(),
  fragment_b: z.string().min(1).max(10_000).optional(),
  rgroups: z.record(z.string(), z.array(z.string())).optional(),
  max_proposals: z.number().int().min(1).max(500).default(50),
});
export type GenerateFocusedLibraryInput = z.infer<typeof GenerateFocusedLibraryIn>;

const Proposal = z.object({
  smiles: z.string(),
  inchikey: z.string().nullable(),
  parent_inchikey: z.string().nullable().optional(),
  transformation: z.record(z.string(), z.unknown()).default({}),
  scores: z.record(z.string(), z.number()).default({}),
});

export const GenerateFocusedLibraryOut = z.object({
  run_id: z.string().nullable(),
  kind: z.string(),
  n_proposed: z.number(),
  proposals: z.array(Proposal),
});
export type GenerateFocusedLibraryOutput = z.infer<typeof GenerateFocusedLibraryOut>;

const TIMEOUT_MS = 120_000;

export function buildGenerateFocusedLibraryTool(mcpGenchemUrl: string) {
  const base = mcpGenchemUrl.replace(/\/$/, "");
  return defineTool({
    id: "generate_focused_library",
    description:
      "Propose a chemically reasonable library around a seed SMILES. " +
      "kind='scaffold' or 'rgroup' enumerate over [*:N] attachment points; " +
      "'bioisostere' applies curated bioisostere rewrites; 'grow' uses RDKit " +
      "BRICS to extend a fragment; 'link' connects two fragments via short " +
      "linkers. Returns gen_runs.run_id + ranked proposals (canonical SMILES " +
      "+ InChIKey).",
    inputSchema: GenerateFocusedLibraryIn,
    outputSchema: GenerateFocusedLibraryOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      const kind = input.kind ?? "scaffold";
      const max = input.max_proposals ?? 50;
      let path: string;
      let payload: Record<string, unknown>;
      switch (kind) {
        case "scaffold":
          path = "/scaffold_decorate";
          payload = {
            scaffold_smiles: input.seed_smiles,
            rgroups: input.rgroups ?? {},
            rgroup_library: input.rgroups ? "custom" : "default",
            max_proposals: max,
          };
          break;
        case "rgroup":
          path = "/rgroup_enumerate";
          payload = {
            core_smiles: input.seed_smiles,
            rgroups: input.rgroups ?? {},
            max_total: max,
          };
          break;
        case "bioisostere":
          path = "/bioisostere_replace";
          payload = { query_smiles: input.seed_smiles, max_substitutions: 2 };
          break;
        case "grow":
          path = "/fragment_grow";
          payload = { fragment_smiles: input.seed_smiles, n: max };
          break;
        case "link":
          if (!input.fragment_a || !input.fragment_b) {
            throw new Error("kind='link' requires fragment_a and fragment_b");
          }
          path = "/fragment_link";
          payload = {
            fragment_a_smiles: input.fragment_a,
            fragment_b_smiles: input.fragment_b,
            max_proposals: max,
          };
          break;
      }
      return await postJson(
        `${base}${path}`,
        payload,
        GenerateFocusedLibraryOut,
        TIMEOUT_MS,
        "mcp-genchem",
      );
    },
  });
}
