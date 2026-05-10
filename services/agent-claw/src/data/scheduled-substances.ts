// Scheduled-substance deny-list for the pre_tool scheduled-substance gate.
//
// Used by `core/hooks/scheduled-substance-gate.ts` to refuse tool calls that
// reference any verbatim canonical SMILES / InChIKey on the curated list.
// This is a defense-in-depth layer that complements:
//   - LiteLLM redaction (egress side, regex-based)
//   - permission_policies (regex over tool_pattern + argument_pattern)
//
// Limitations the integrator must know about:
//   1. Matching is verbatim canonical-SMILES / InChIKey equality after a
//      cheap normalisation (case-fold + whitespace strip). It will NOT
//      catch a tautomer, salt form, isotopologue, stereoisomer-drop, or
//      Kekulé/aromatic re-write of the listed structure. A follow-up in
//      the gap-plan moves to substructure matching via mcp_rdkit's
//      /tools/substructure_match endpoint (BACKLOG H0.9 follow-up).
//   2. The list is a defensive seed, not a complete regulatory catalog.
//      Tenants extend it via `permission_policies` for org-specific items;
//      a full per-tenant DB-backed catalog is also a follow-up.
//   3. Names + canonical SMILES below are sourced from widely-published
//      public references (OPCW Schedule 1 list, DEA Controlled Substance
//      Schedules, US EAR Commerce Control List Cat 1C) and PubChem CIDs.
//      Citations are in comments next to each entry.
//
// Severity semantics:
//   - "deny" → return permissionDecision: "deny" (hard block)
//   - "ask"  → return permissionDecision: "ask"  (require attestation)
// Pharma agents legitimately work with controlled substances under DEA
// registration; "ask" lets a human attestation override the block while
// keeping an audit trail. CWC Schedule-1 chemical-warfare agents stay
// "deny" — there is no legitimate pharma research use.

export type ScheduledSubstanceList =
  | "CWC_SCHEDULE_1"
  | "DEA_SCHEDULE_I"
  | "EAR_CAT_1C";

export type ScheduledSubstanceSeverity = "deny" | "ask";

export interface ScheduledSubstanceEntry {
  /** Display name for diagnostics + audit logs. */
  readonly name: string;
  /** Canonical SMILES (RDKit-canonicalised). Multiple variants may be
   *  listed for the same logical substance; each becomes an independent
   *  match candidate. */
  readonly canonical_smiles: readonly string[];
  /** Standard InChIKey (14-10-1 form). Optional — present when verified
   *  against PubChem; absent when the substance has multiple stereoforms
   *  on its regulatory listing. */
  readonly inchikey?: readonly string[];
  /** Regulatory list IDs the entry derives from. */
  readonly lists: readonly ScheduledSubstanceList[];
  /** Decision tier the gate emits when this entry matches. */
  readonly severity: ScheduledSubstanceSeverity;
}

/**
 * Seed catalog. Curated deliberately small — this is a deny-list, not a
 * structure database. Extend tenant-locally via `permission_policies` or
 * via the planned `scheduled_substance_catalog` table (gap-plan H0.9
 * follow-up).
 *
 * Regulatory references:
 * - CWC Schedule 1: https://www.opcw.org/chemical-weapons-convention/annexes/annex-on-chemicals
 * - DEA Schedules:  https://www.deadiversion.usdoj.gov/schedules/
 * - EAR Cat 1C:     https://www.bis.doc.gov/index.php/regulations/commerce-control-list-ccl
 */
export const SCHEDULED_SUBSTANCES: readonly ScheduledSubstanceEntry[] = [
  // --- CWC Schedule 1 — chemical warfare agents (no legitimate pharma use) ---
  {
    name: "Sarin (GB)",
    // PubChem CID 7871; OPCW Schedule 1.A.1
    canonical_smiles: ["CC(C)OP(C)(=O)F"],
    inchikey: ["DYAHQFWOVKZOOW-UHFFFAOYSA-N"],
    lists: ["CWC_SCHEDULE_1"],
    severity: "deny",
  },
  {
    name: "VX",
    // PubChem CID 39793; OPCW Schedule 1.A.3
    canonical_smiles: ["CCOP(C)(=O)SCCN(C(C)C)C(C)C"],
    inchikey: ["LBUJPTNKIBCYBY-UHFFFAOYSA-N"],
    lists: ["CWC_SCHEDULE_1"],
    severity: "deny",
  },
  {
    name: "Soman (GD)",
    // PubChem CID 7548; OPCW Schedule 1.A.1
    canonical_smiles: ["CC(C(C)(C)C)OP(C)(=O)F"],
    inchikey: ["LBHIOVVIQHSOQN-UHFFFAOYSA-N"],
    lists: ["CWC_SCHEDULE_1"],
    severity: "deny",
  },
  {
    name: "Tabun (GA)",
    // PubChem CID 6428803; OPCW Schedule 1.A.2
    canonical_smiles: ["CCOP(=O)(C#N)N(C)C"],
    inchikey: ["PBLZLIFKVPJDCO-UHFFFAOYSA-N"],
    lists: ["CWC_SCHEDULE_1"],
    severity: "deny",
  },
  {
    name: "Sulfur mustard (HD)",
    // PubChem CID 10461; OPCW Schedule 1.A.4
    canonical_smiles: ["ClCCSCCCl", "C(CCl)SCCCl"],
    inchikey: ["QKSKPIVNLNLAAV-UHFFFAOYSA-N"],
    lists: ["CWC_SCHEDULE_1"],
    severity: "deny",
  },
  {
    name: "Nitrogen mustard (HN-3)",
    // PubChem CID 4033; OPCW Schedule 1.A.6
    canonical_smiles: ["ClCCN(CCCl)CCCl"],
    inchikey: ["FFFAQEYNVZOBLU-UHFFFAOYSA-N"],
    lists: ["CWC_SCHEDULE_1"],
    severity: "deny",
  },
  {
    name: "Lewisite 1 (L1)",
    // PubChem CID 5372798; OPCW Schedule 1.A.13
    canonical_smiles: ["Cl/C=C/[As](Cl)Cl", "ClC=C[As](Cl)Cl"],
    inchikey: ["WIRBVQVWKNRBNB-UHFFFAOYSA-N"],
    lists: ["CWC_SCHEDULE_1"],
    severity: "deny",
  },
  {
    name: "BZ (3-Quinuclidinyl benzilate)",
    // PubChem CID 2687; OPCW Schedule 2.A.3 — listed here as deny
    // because there is no pharma synthesis-development use case.
    canonical_smiles: [
      "OC(c1ccccc1)(c1ccccc1)C(=O)OC1CN2CCC1CC2",
    ],
    inchikey: ["NBMKJKDGKREAPL-UHFFFAOYSA-N"],
    lists: ["CWC_SCHEDULE_1"],
    severity: "deny",
  },

  // --- DEA Schedule I — abuse potential, no accepted medical use in US ---
  // Severity: "ask" rather than "deny" because legitimate research under
  // DEA registration exists; tenant policy can override to "deny".
  {
    name: "Heroin (diacetylmorphine)",
    // PubChem CID 5462328; DEA Schedule I
    canonical_smiles: [
      "CC(=O)OC1C=CC2C3Cc4ccc(OC(C)=O)c5OC1C2(CCN3C)c45",
    ],
    inchikey: ["GVGLGOZIDCSQPN-UHFFFAOYSA-N"],
    lists: ["DEA_SCHEDULE_I"],
    severity: "ask",
  },
  {
    name: "LSD (lysergic acid diethylamide)",
    // PubChem CID 5761; DEA Schedule I
    canonical_smiles: [
      "CCN(CC)C(=O)C1CN(C)C2Cc3c[nH]c4cccc(C2=C1)c34",
    ],
    inchikey: ["VAYOSLLFUXYJDT-UHFFFAOYSA-N"],
    lists: ["DEA_SCHEDULE_I"],
    severity: "ask",
  },
  {
    name: "MDMA (3,4-methylenedioxymethamphetamine)",
    // PubChem CID 1615; DEA Schedule I (rescheduling under FDA review)
    canonical_smiles: ["CC(Cc1ccc2c(c1)OCO2)NC"],
    inchikey: ["SHXWCVYOXRDMCX-UHFFFAOYSA-N"],
    lists: ["DEA_SCHEDULE_I"],
    severity: "ask",
  },

  // --- EAR Cat 1C — dual-use chemical precursors (export-controlled) ---
  // Severity: "ask" — these are commodity chemicals with legitimate uses;
  // the gate exists to surface a notice, not block routine work. A tenant
  // can override per-org via permission_policies.
  {
    name: "Thiodiglycol (mustard precursor)",
    // PubChem CID 5447; EAR ECCN 1C350
    canonical_smiles: ["OCCSCCO"],
    inchikey: ["WUGQZFFCHPXWKQ-UHFFFAOYSA-N"],
    lists: ["EAR_CAT_1C"],
    severity: "ask",
  },
  {
    name: "Methylphosphonic dichloride",
    // PubChem CID 24017; EAR ECCN 1C350 (sarin/soman precursor)
    canonical_smiles: ["CP(=O)(Cl)Cl"],
    inchikey: ["CDOOFZZILLRUQH-UHFFFAOYSA-N"],
    lists: ["EAR_CAT_1C"],
    severity: "ask",
  },
];

// ---------------------------------------------------------------------------
// Lookup index — pre-computed at module load. Two maps so the hook does a
// single Map.get() per input string and per InChIKey-shaped input.
// ---------------------------------------------------------------------------

export interface CompiledCatalog {
  /** Normalised canonical SMILES → entry. */
  readonly bySmiles: ReadonlyMap<string, ScheduledSubstanceEntry>;
  /** Upper-case InChIKey → entry. */
  readonly byInchiKey: ReadonlyMap<string, ScheduledSubstanceEntry>;
  /** Distinct entries for diagnostics. */
  readonly entries: readonly ScheduledSubstanceEntry[];
}

/**
 * Normalise a SMILES-like string for verbatim comparison. Strips ASCII
 * whitespace; canonical SMILES is case-sensitive (lowercase = aromatic
 * atom) so we DO NOT case-fold here.
 */
export function normaliseSmiles(s: string): string {
  return s.replace(/\s+/g, "");
}

/** True iff the string looks like a Standard InChIKey (14-10-1). */
export function looksLikeInchiKey(s: string): boolean {
  return /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/.test(s);
}

export function compileCatalog(
  entries: readonly ScheduledSubstanceEntry[] = SCHEDULED_SUBSTANCES,
): CompiledCatalog {
  const bySmiles = new Map<string, ScheduledSubstanceEntry>();
  const byInchiKey = new Map<string, ScheduledSubstanceEntry>();
  for (const entry of entries) {
    for (const s of entry.canonical_smiles) {
      bySmiles.set(normaliseSmiles(s), entry);
    }
    for (const k of entry.inchikey ?? []) {
      byInchiKey.set(k.toUpperCase(), entry);
    }
  }
  return { bySmiles, byInchiKey, entries };
}
