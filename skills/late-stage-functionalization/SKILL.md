---
id: late-stage-functionalization
description: "Propose late-stage functionalization (LSF) conditions — Minisci C-H, photoredox, borylation, directed C-H — for an advanced intermediate. Specialist-routed; defers to condition-design when no LSF context is detected."
version: 1
tools:
  - canonicalize_smiles
  - recommend_conditions
  - assess_applicability_domain
  - score_green_chemistry
  - find_similar_reactions
  - predict_yield_with_uq
  - search_knowledge
  - fetch_original_document
  - query_kg
max_steps_override: 24
---

# Late-Stage Functionalization (LSF) skill

Activated when the user asks for "C-H activation conditions for X", "Minisci
on Y", "photoredox decarboxylative coupling", "Ir-borylation of <substrate>",
"DoM / directed C-H functionalization", or types
`/lsf <substrate-smiles> <reagent-class>`.

Late-stage functionalization is the dominant tool for medchem SAR exploration
on advanced intermediates: a single C-H bond is selectively activated late in
the synthesis to install fluorine, deuterium, methyl, CF3, aryl, alkyl, or a
borylester. The chemistry is **subtle** — selectivity flips with directing
group, oxidation state, and even solvent — so a generic recommender is
unreliable here. This skill routes to LSF-aware specialists when it detects
an LSF context, and otherwise defers to `condition-design`.

## When to engage

Trigger this skill when the user's reactants or product imply an LSF context:

- **Minisci** — heteroaryl substrate (pyridine, pyrimidine, quinoline) being
  alkylated with a carboxylic acid, alkyl iodide, or trifluoroborate under
  AgNO3 / persulfate / photoredox.
- **Borylation** — Ir-catalyzed (Hartwig / Smith / Boger) C-H borylation of
  an arene, heteroarene, or sp3 C-H to install Bpin / Bcat.
- **Photoredox** — visible-light single-electron transformations: HAT,
  decarboxylative coupling, fluorination (Selectfluor / NFSI), CF3 (Togni / Umemoto).
- **Directed C-H activation** — Pd / Rh / Ir with pyridine, amide, or
  N-protecting group directing C-H bond cleavage.

If the substrate is a simple coupling partner (aryl halide + amine → Buchwald)
**defer to `condition-design`** — that skill handles the generic case and is
already AD- and greenness-gated.

## Approach

1. **Canonicalize and classify.** Pass the substrate (and any reagent SMILES)
   through `canonicalize_smiles`. Classify the requested transformation into
   one of: `minisci`, `borylation`, `photoredox`, `directed_ch`, or `other`.
   Use `query_kg` if the user names a coupling partner only loosely
   ("methylate this pyridine") to look up canonical reagents for the class.
2. **Run the recommender + AD jointly.** Call `recommend_conditions` on the
   substrate >> product reaction; in parallel call `assess_applicability_domain`
   on the same SMILES. ASKCOS was trained on USPTO 1976-2016 — most LSF
   chemistry is post-2016, so AD will frequently flag OOD here. **That is
   informative, not blocking** — record the verdict and continue.
3. **Specialist re-rank by class.** Re-rank the recommender's output using
   class-specific knowledge:
   - **Minisci**: prioritize photoredox-Minisci (Phipps, MacMillan 2018+) over
     classical AgNO3/persulfate when the substrate has an oxidizable site;
     classical when substrate is robust.
   - **Borylation**: prefer `[Ir(COD)OMe]2 / dtbpy / B2Pin2` for aryl C-H;
     `Cp*Rh / norbornene` or directed variants for sp3 C-H.
   - **Photoredox**: surface mediator + reductive/oxidative quench cycle
     compatibility (Ir(ppy)3, Ru(bpy)3, 4CzIPN, acridinium) and a sane
     wavelength window for the medchem photoreactor (450 nm or 390 nm).
   - **Directed C-H**: surface the directing group (pyridine, 8-aminoquinoline,
     bidentate amide) and predicted regiochemistry (ortho / β / γ).
4. **Cite the canonical literature precedent.** For each top-3 recommendation
   call `search_knowledge` with `{transformation_class}+{substrate_class}` and
   `fetch_original_document` on the top hit. **Required** — LSF papers are
   the single source of truth for whether a condition will work; the
   recommender alone is not enough. Cite as `[doc:<uuid>:<chunk_index>]`.
5. **Yield + greenness sanity.** Call `predict_yield_with_uq` per condition
   set (informational; LSF yields are routinely 20-50%, lower is normal).
   Call `score_green_chemistry` to surface PMI / hazard score; LSF often uses
   AcOH, TFA, or HFIP — these flag CHEM21-yellow but are **acceptable for
   medchem-scale LSF** (note this in the response).
6. **Surface known regio-selectivity issues.** Use `query_kg` to look up
   directing-group conflicts, known C-H selectivity inversions, or substrate
   classes where the proposed system is known to fail (e.g. electron-rich
   pyridines under photoredox-Minisci tend to over-alkylate).
7. **Anchor with in-house analogs if available.** Call `find_similar_reactions`
   on the canonical reaction SMILES. **In-house LSF data is rare** — when
   nothing turns up, say so explicitly rather than fabricating a similarity.

## Output conventions

- Present the top-3 as a table: catalyst / mediator, oxidant / reductant,
  ligand or photocatalyst, solvent, T (°C), wavelength (if photoredox),
  predicted yield ± std, AD verdict, greenness, lit-precedent citation,
  expected regiochemistry, and known failure modes.
- **Always cite at least one literature procedure per recommendation**. If
  none can be found, mark the recommendation `confidence_tier="exploratory"`
  and warn the user that this is a literature-thin transformation.
- State explicitly when the AD verdict is OOD that this is **expected for
  LSF** (recommender training set is older than most LSF methodology) and
  that the literature citation is therefore the primary source of truth.
- Recommend the user consider an HTE plate (`hte-plate-design`) when picking
  among 2-3 mechanistically distinct options — LSF outcomes are notoriously
  hard to predict and a 24-well screen is often faster than a literature
  deep-dive.

## What this skill does NOT do

- **Replace `condition-design`**. For non-LSF chemistry (Buchwald, Suzuki,
  amide coupling, reductive amination) defer to that skill — it is already
  AD- and greenness-gated and will give a better answer for those classes.
- **Predict regiochemistry quantitatively**. Heuristics only. For predictive
  regio-control use the dedicated GNN models tracked for a future phase
  (Predictive Minisci, borylation-HTE).
- **Handle photoreactor scheduling or hardware**. Out of scope; ORD export
  via `hte-plate-design` is the hand-off point.
