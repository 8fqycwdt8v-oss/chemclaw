// Shared Zod fragments used by the qm_* builtins. Importing these from one
// place stops the seven near-identical schemas in qm_single_point /
// qm_geometry_opt / qm_frequencies / qm_fukui / qm_redox_potential /
// qm_crest_screen from drifting apart.

import { z } from "zod";

export const QmMethodEnum = z.enum([
  "GFN0",
  "GFN1",
  "GFN2",
  "GFN-FF",
  "g-xTB",
  "sTDA-xTB",
  "IPEA-xTB",
]);
export type QmMethod = z.infer<typeof QmMethodEnum>;

export const SolventModelEnum = z.enum(["none", "alpb", "gbsa", "cpcmx"]);
export type SolventModel = z.infer<typeof SolventModelEnum>;

/**
 * Shared base shape for any single-molecule xTB request. Builtins extend
 * this with task-specific fields (`threshold` for opt, `electrons` for
 * redox, etc.) using `.extend(...)`.
 */
export const QmRequestBase = z.object({
  smiles: z.string().min(1).max(10_000),
  method: QmMethodEnum.default("GFN2"),
  charge: z.number().int().default(0),
  multiplicity: z.number().int().min(1).default(1),
  solvent_model: SolventModelEnum.default("none"),
  solvent_name: z.string().optional(),
  force_recompute: z.boolean().default(false).describe(
    "Bypass the QM cache and force a fresh xTB run. Use sparingly.",
  ),
});

/** Fields common to every xTB response. Builtins extend with task extras. */
export const QmResponseBase = z.object({
  job_id: z.string().nullable(),
  cache_hit: z.boolean(),
  status: z.string(),
  summary: z.string(),
  method: z.string(),
  task: z.string(),
});
