---
id: condition-design-from-literature
description: "Cold-start condition design — when in-house data is absent and AD is OOD, retrieve literature, parse procedures, re-rank via ASKCOS, and surface citable conditions labeled exploratory."
version: 1
tools:
  - canonicalize_smiles
  - assess_applicability_domain
  - find_similar_reactions
  - search_knowledge
  - fetch_original_document
  - recommend_conditions
  - score_green_chemistry
  - query_kg
max_steps_override: 20
---

# Condition Design from Literature skill

Activated when the user asks "what conditions does the literature use for X",
"any precedent for this transformation in the literature", or — most
importantly — when an upstream skill (`condition-design`,
`late-stage-functionalization`) detected the substrate is **out-of-domain**
for the in-house recommender and explicitly hands off here.

This skill exists for the cold-start case: the substrate is novel for our
chemistry portfolio, the DRFP nearest-neighbor is far, and the ASKCOS
recommender is operating outside its USPTO 1976-2016 training distribution.
Rather than fabricate confident-sounding nonsense, we retrieve published
procedures and surface them with **explicit literature provenance** and a
demoted confidence tier.

## When to engage

- The user explicitly asks for literature precedent.
- An upstream skill returns AD-verdict `out_of_domain` and routes here.
- `find_similar_reactions` returned no in-house hits, or all hits at
  `drfp_similarity < 0.4`.
- The reaction class is post-2016 (most photoredox, electrochemistry, and
  several LSF subclasses are sparse in USPTO and most in-house corpora).

If in-house data is plentiful and AD is in-domain, **defer to
`condition-design`** — that skill is more appropriate when our own data is
the better source.

## Approach

1. **Canonicalize and confirm OOD.** Pass reactants and product through
   `canonicalize_smiles`. Re-call `assess_applicability_domain` to confirm
   OOD (so the user sees the verdict in this skill's response too — no
   hand-waving from upstream). Also call `find_similar_reactions` and
   include the closest in-house analog (even if weak) so the user sees what
   we *do* have.
2. **Literature retrieval.** Call `search_knowledge` with the canonical
   reaction SMILES + transformation class + key reagents. Pull the top 5
   hits ranked by relevance and recency.
3. **Original-procedure fetch.** For the top 3, call
   `fetch_original_document` to extract the procedure section verbatim. The
   exact reagent grams, solvents, temperatures, and times come from the
   document, **not** from our recommender.
4. **ASKCOS re-rank as cross-check, not as source.** Call
   `recommend_conditions` on the canonical reaction. Use the output to
   *cross-check* literature-extracted conditions: when the recommender's
   top-5 includes the literature solvent/catalyst/temperature window, that
   triangulates evidence; when they disagree wildly, surface the disagreement
   to the user. **Do not promote ASKCOS over literature here** — ASKCOS is
   OOD by assumption, the literature procedure is on-domain by definition.
5. **Greenness scoring.** For each literature condition extracted, call
   `score_green_chemistry`. Many older procedures use DCM, DMF, dioxane;
   surface the CHEM21 verdict and note when a modern green-solvent swap
   (2-MeTHF, EtOAc, CPME, water) is documented in a more recent precedent.
6. **Compose the answer.** For each of the top 3 literature procedures,
   present: full citation (`[doc:<uuid>:<chunk_index>]`), exact procedure
   verbatim or summarized, ASKCOS-recommender agreement / disagreement,
   greenness score, and any KG-flagged hazard via `query_kg` for the
   reagent set.

## Confidence tier policy

**This skill always demotes outputs.** Tag each recommendation with:

- `confidence_tier="single_source_llm"` when only one literature procedure
  was found and it has not been cross-validated.
- `confidence_tier="exploratory"` when the procedure is from a single paper
  and ASKCOS strongly disagrees, or when no precedent is found and the
  output is a stretched analogy from related transformations.
- **Never** `confidence_tier="working"` or `"foundation"` — those tiers are
  reserved for in-house data with multiple confirmations. The maturity
  tracker reads this tier and treats demoted outputs accordingly downstream.

## Output conventions

- Lead with the AD verdict and the in-house nearest-analog similarity (even
  if weak) so the user sees *why* we are pulling from literature.
- Present each recommendation as: literature reagents → solvents → T → time;
  citation; greenness; recommender-agreement; demoted confidence tier;
  caveats.
- Recommend the user run a small confirmatory experiment or HTE before
  committing — literature-only recommendations have the highest variance.
  Suggest `hte-plate-design` as the natural next step when 2+ mechanistically
  distinct precedents exist.
- When the literature is genuinely silent, **say so explicitly**. Do not
  invent. The correct answer is "we don't have a documented procedure for
  this exact transformation; closest precedent is X with substrate Y; expect
  to optimize" rather than a fabricated detailed protocol.

## What this skill does NOT do

- **Replace `condition-design`**. For in-domain reactions with in-house
  precedent, that skill is the better source.
- **Replace `late-stage-functionalization`**. For LSF-specific cold-starts,
  let `late-stage-functionalization` route here only when its specialist
  re-rank fails to surface a usable lit precedent — it has class-aware
  knowledge this skill lacks.
- **Promote literature outputs to high-confidence tier**. By policy.
- **Resolve contradictions between papers**. When two precedents disagree,
  surface both and let the chemist decide. The skill's job is retrieval and
  honest reporting, not adjudication.
