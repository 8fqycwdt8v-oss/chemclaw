---
id: condition-design
description: "Propose forward reaction conditions (catalyst / reagent / solvent / temperature) for a target transformation, anchored to historical analogs. Returns AD verdict + soft-greenness-adjusted ranking."
version: 2
tools:
  - canonicalize_smiles
  - recommend_conditions
  - find_similar_reactions
  - assess_applicability_domain
  - score_green_chemistry
  - predict_reaction_yield
  - search_knowledge
  - query_kg
  - fetch_original_document
max_steps_override: 25
---

# Condition Design skill (v2 — AD + greenness)

Activated when the user asks "what conditions for X", "propose conditions for
this reaction", "Buchwald between A and B?", or types
`/conditions <reactants> >> <product>`.

## Approach

1. **Canonicalize inputs.** Pass reactants and product through
   `canonicalize_smiles` so all downstream tools see the same representation.
2. **Recommend conditions.** Call `recommend_conditions` with the canonical
   reactants + product (default top_k=5). Output: ranked list of
   {catalysts, reagents, solvents, temperature_c, score}.
3. **Anchor to historical analog.** For each top recommendation, call
   `find_similar_reactions` on the reaction SMILES (`reactants>>product`).
   Cite the nearest analog as `[rxn:<uuid>]`.
4. **Applicability-domain check (Z1, NEW).** Call
   `assess_applicability_domain` ONCE for the query reaction (NOT once per
   recommendation — they all share the same reaction). Pass
   `project_internal_id` from the user's session context if available.
   The result has `verdict`, `tanimoto_signal`, `mahalanobis_signal`,
   `conformal_signal`, `used_global_fallback`. **All recommendations inherit
   the same verdict.** Annotate-don't-block: surface the verdict but do not
   suppress recommendations.
5. **Greenness scoring (Z1, NEW).** Collect the union of solvents across all
   top-k recommendations. Call `score_green_chemistry` once with the union.
   Map results back to each recommendation by canonical SMILES.
6. **Soft-penalty re-ranking (Z1, NEW).** For each recommendation, compute:
   ```
   hazard_penalty_per_solvent = {
       'HighlyHazardous': 0.40, 'Hazardous': 0.20,
       'Problematic': 0.10, 'Recommended': 0.00, null: 0.05
   }
   worst_penalty   = max over the recommendation's solvents
   final_rank_score = recommender_score * (1.0 - worst_penalty)
   ```
   Re-rank by `final_rank_score` descending. **Show both the original
   recommender_score AND final_rank_score in the rendered table.**
7. **Yield sanity check.** For each top-3 (post re-ranking), build a reaction
   SMILES and call `predict_reaction_yield` for an expected yield ± std.
   Informational only.
8. **Risks.** Use `query_kg` to look up known reagent hazards or
   substrate-class incompatibilities; flag matches against the recommended
   condition set.
9. **Optional literature cross-reference.** If the AD verdict is
   `out_of_domain` OR the in-house analog at step 3 has cosine distance
   > 0.70, call `search_knowledge` for the reaction class + reagent context,
   then `fetch_original_document` on the top-1 hit for a citable procedure.

## Output conventions

Present the top-k as a table:
- Columns: catalyst(s), reagent(s), solvent(s), T (°C), recommender_score,
  final_rank_score, worst_solvent_class, predicted_yield ± std, AD verdict,
  nearest in-house analog, risks.
- Order by `final_rank_score` descending (post soft-penalty).
- Cite in-house analogs as `[rxn:<uuid>]`. Cite literature procedures as
  `[doc:<uuid>:<chunk_index>]`.
- Include the AD verdict + per-signal scores under the table:
  > **AD verdict:** borderline. Tanimoto distance 0.42 (in_band ≤ 0.50);
  > Mahalanobis 1842 / 2150 (in_band); Conformal half-width 35 / 30
  > (out-of-band). The recommender is operating on chemotypes near but not
  > inside the in-house Buchwald corpus; treat the top-3 as starting points
  > for an HTE plate, not a single-experiment commitment.
- If `used_global_fallback: true`, add: "AD calibration drew from cross-
  project data because this project has < 30 prior yield-labeled reactions."
- State the recommender's known limits in the conclusion: USPTO 1976-2016,
  top-10 includes ground truth ~70% of the time, T MAE ~20 °C.

## Soft-penalty transparency

When a chemist says "we have to use DCM for this" or "weight greenness
less", recompute the table with `hazard_penalty_per_solvent[*] = 0.0` for
that turn and surface both rankings side-by-side. Never silently swap.

## Latency expectations

- recommend_conditions: ~5-15 s.
- find_similar_reactions: <1 s.
- assess_applicability_domain: ~2-5 s (one DRFP encode + 2 DB queries +
  chemprop batch on calibration + 2 MCP calls; calibration cache makes
  intra-turn re-calls cheap).
- score_green_chemistry: <1 s.
- predict_reaction_yield: ~2 s per call.
- query_kg + search_knowledge: ~1 s each.
- Total skill turn: ~30-90 s.

## What this skill does NOT do (still deferred)

- HTE plate design — different skill (`hte-plate-design`, Phase Z4).
- Closed-loop optimization — different skill (`closed-loop-optimization`,
  Phase Z5). This skill is single-experiment / one-shot.
- Multi-objective Pareto over yield × selectivity × PMI × greenness × safety
  — Phase Z6.
