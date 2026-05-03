---
id: hte-plate-design
description: "Design an HTE plate (24/96/384/1536) for a target reaction via BoFire space-filling DoE; annotate wells with predicted yield + UQ; optionally export to ORD."
version: 1
tools:
  - canonicalize_smiles
  - recommend_conditions
  - design_plate
  - predict_yield_with_uq
  - export_to_ord
  - find_similar_reactions
  - query_kg
max_steps_override: 25
---

# HTE Plate Design skill

Activated when the user asks "design a 96-well screen for X", "set up an HTE
plate", "/plate <reactants> >> <product>", or similar batch-experiment requests.

## Approach

1. **Canonicalize inputs.** Pass reactants and product through
   `canonicalize_smiles` so all downstream tools see the same representation.
2. **Solicit prior conditions.** Call `recommend_conditions` (Z0) with
   `top_k=10`. The recommender's catalysts / bases / solvents become the
   *categorical_inputs* lists for the design.
3. **Design the plate.** Call `design_plate` with:
   - `plate_format` from the user's request (default 96).
   - `factors` for continuous variables: `temperature_c` range, optional
     `loading_mol_pct`, `time_min`.
   - `categorical_inputs` from step 2 (catalyst, base, solvent).
   - `exclusions.solvents` for any user-supplied "exclude DCM" / "exclude DMF".
   - `n_wells` matches plate_format (e.g. 96 for 96-well).
   - `annotate_yield: true` if the agent has a project_internal_id from session
     context — gives ensemble_mean ± ensemble_std for the reaction.
   - `seed` for reproducibility (default 42).
4. **Surface the safety floor.** If `design_metadata.applied_chem21_floor` is
   non-empty, **explicitly state** in the response which solvents were
   auto-dropped and why ("DCM auto-excluded — CHEM21 HighlyHazardous").
5. **Render the plate.** Markdown table with columns: well_id, T (°C),
   loading (mol%), catalyst, base, solvent. Group by row (A, B, C, ...).
6. **Show yield summary** (when `yield_summary` non-null): "Predicted yield
   for this transformation (broadcast to all wells, since reactants don't
   vary): 65 ± 7%. Used global fallback: false."
7. **Optional ORD export.** If the user says "export to ORD" or
   "give me a robot-ready file", call `export_to_ord` and surface the
   `ord_protobuf_b64` as a downloadable artifact.

## Output conventions

- Order wells by `well_id` (A01, A02, ..., H12 for 96-well).
- When the CHEM21 floor was applied, surface the override option:
  > "DCM auto-excluded under the CHEM21 HighlyHazardous floor. To override
  > for this campaign, re-run with `disable_chem21_floor: true`."
- Include the BoFire `domain_json` reference in the response so the chemist
  knows Z5's optimizer can warm-start from this design.

## Latency expectations

- recommend_conditions: ~5-15 s
- design_plate (96 wells, no annotation): <2 s
- design_plate (96 wells, annotated): ~5-10 s (one yield call broadcast)
- export_to_ord: <1 s
- Total skill turn: ~10-25 s

## What this skill does NOT do (deferred)

- **Closed-loop optimization** — Z5's BoFire optimizer takes this plate's
  `domain_json` and refines via q-NEHVI / q-LogEI given measured outcomes.
- **Multi-objective trade-offs** (yield × selectivity × PMI × greenness ×
  safety) — Z6.
- **Hardware-specific row/col scrambling** for positive-control placement.
- **Importing existing ORD bundles** — `mcp_ord_io /import` exists but the
  `import_from_ord.ts` builtin is deferred.
