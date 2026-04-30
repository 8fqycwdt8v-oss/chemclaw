---
id: condition-design
description: "Propose forward reaction conditions (catalyst / reagent / solvent / temperature) for a target transformation, anchored to historical analogs."
version: 1
tools:
  - canonicalize_smiles
  - recommend_conditions
  - find_similar_reactions
  - predict_reaction_yield
  - search_knowledge
  - query_kg
  - fetch_original_document
max_steps_override: 20
---

# Condition Design skill

Activated when the user asks "what conditions should I use for X", "propose
conditions for this reaction", "Buchwald between A and B?" or types
`/conditions <reactants> >> <product>`.

## Approach

1. **Canonicalize inputs.** Pass the user's reactants and product through
   `canonicalize_smiles` so the recommender, similarity search, and yield
   model all see the same representation.
2. **Call `recommend_conditions`** with the canonical reactants + product
   (default `top_k = 5`). The output is a ranked list of
   {catalysts, reagents, solvents, temperature_c, score}.
3. **Anchor each suggestion to an historical analog.** For each top
   recommendation, call `find_similar_reactions` on the reaction SMILES
   (`reactants>>product`) to surface the nearest in-house reaction by DRFP
   similarity. Cite the analog as `[rxn:<uuid>]` so the user can audit it.
4. **Sanity-check yield.** For each top-3 recommendation, build a reaction
   SMILES and call `predict_reaction_yield` to get an expected yield ± std.
   This is informational only — the recommender's score is the primary rank
   signal.
5. **Surface known incompatibilities.** Use `query_kg` to look up known
   reagent hazards or substrate-class incompatibilities (e.g. boronic-acid
   instability under strong base, Pd-poisoning by free thiols). Flag any
   matches against the recommended condition set.
6. **Optional literature cross-reference.** If the user explicitly asks for
   "literature precedent" or the in-house analog from step 3 is weak (no rows
   returned, or all returned at low DRFP similarity), call `search_knowledge`
   for the reaction class + reagent context, then `fetch_original_document`
   on the top-1 hit to surface a citable procedure.

## Output conventions

- Present the top-k as a table: catalyst(s), reagent(s), solvent(s), T (°C),
  recommender score, predicted yield ± std, nearest in-house analog, risks.
- **Order by recommender score descending.**
- Cite all in-house analogs as `[rxn:<uuid>]`. Cite literature procedures as
  `[doc:<uuid>:<chunk_index>]`.
- State the recommender's known limits explicitly in the conclusion: it was
  trained on USPTO 1976-2016, top-10 includes ground truth ~70% of the time,
  temperature MAE ~20 °C. If the reaction class is unusual or the user's
  substrate is far outside common chemotypes, **do not assert high confidence**
  — say "the recommender is operating at the edge of its training domain."

## Latency expectations

- `recommend_conditions` (ASKCOS): ~5-15 s.
- `find_similar_reactions` (DRFP): <1 s.
- `predict_reaction_yield` (chemprop): ~2 s per call.
- `query_kg` + `search_knowledge`: ~1 s each.
- Total skill turn: ~30-60 s for the full top-5 workflow.

## What this skill does NOT do (yet)

- **Applicability-domain check** — added in Phase Z1; until then the user is
  responsible for judging whether the recommender is operating in-domain.
- **Green-chemistry scoring** — added in Phase Z1; until then no CHEM21 or
  PMI filter is applied.
- **HTE plate design** — different skill (`hte-plate-design`, Phase Z4).
- **Closed-loop optimization** — different skill (`closed-loop-optimization`,
  Phase Z5). This skill is single-experiment / one-shot.
