---
id: pharma-process-readiness
description: "Aggregate yield UQ, applicability domain, greenness, and safety signals for a target reaction or campaign into a tiered scale-up readiness verdict (exploratory / pilot-ready / scale-ready)."
version: 1
tools:
  - canonicalize_smiles
  - find_similar_reactions
  - predict_yield_with_uq
  - assess_applicability_domain
  - score_green_chemistry
  - extract_pareto_front
  - manage_todos
max_steps_override: 20
---

# Pharma Process Readiness skill

Activated when the user asks "is this ready for scale-up", "what's the
pharma readiness of this campaign", "process-development assessment", or
similar pre-handoff questions before pilot/scale runs.

## Approach

The skill aggregates **five evidence signals** into a single tiered verdict:

1. **Yield magnitude + uncertainty** — `predict_yield_with_uq` (Z3) for the
   target reaction (or the Pareto-best from a campaign).
2. **Applicability domain** — `assess_applicability_domain` (Z1, when
   deployed) for the query reaction. `out_of_domain` blocks scale-ready;
   `borderline` caps at pilot-ready.
3. **Greenness / PMI** — `score_green_chemistry` (Z1) for the solvents
   used. `HighlyHazardous` solvent caps the verdict at pilot-ready unless
   explicitly waived for legal-compliance reasons.
4. **Safety** — `score_green_chemistry /assess_reaction_safety` (Z1) for
   reactant Bretherick group flags. `Explosive` or `Pyrophoric` reagents
   forbid scale-ready without engineering controls.
5. **Historical analogs** — `find_similar_reactions` for evidence of
   prior in-house runs at scale. ≥3 successful prior runs at >100 mg
   strengthens the verdict.

## Verdict tiers

```
scale-ready    : ensemble_mean >= 70%, ensemble_std <= 10%,
                 AD verdict = in_domain,
                 no HighlyHazardous solvents OR explicit waiver,
                 no Explosive/Pyrophoric Bretherick hits
                 OR ≥3 successful prior runs at scale.
pilot-ready    : ensemble_mean >= 50%, ensemble_std <= 20%,
                 AD in_domain or borderline,
                 at most 1 HighlyHazardous solvent,
                 no Explosive Bretherick hits.
exploratory    : ensemble_mean < 50% OR ensemble_std > 20%
                 OR AD = out_of_domain
                 OR Explosive/Pyrophoric reactant.
```

## For a closed-loop campaign

If the user provides a `campaign_id`, additionally:

1. Call `extract_pareto_front(campaign_id)` to get the trade-off frontier.
2. For each Pareto point, run the 5-signal evaluation above.
3. Surface the **best Pareto point per readiness tier** — chemists can
   pick the one whose trade-offs match their priorities (yield-max,
   greenness-max, PMI-min, etc.).

## Output conventions

- Always show the verdict at the top in **bold**.
- Below it, show a 5-row evidence table: yield, AD, greenness, safety,
  prior-art. Each row has the signal's value + the rule it triggered.
- Cite the campaign `[campaign:<uuid>]`, the model_card row(s) backing each
  signal, and any prior in-house runs as `[rxn:<uuid>]`.
- When data is missing for a signal (e.g. AD service down, no prior runs),
  call it out explicitly — silence is treated as a downgrade.

## Latency expectations

- predict_yield_with_uq: ~5-10 s (per Z3).
- assess_applicability_domain: ~2-5 s (per Z1).
- score_green_chemistry: <2 s.
- find_similar_reactions: <2 s.
- extract_pareto_front (campaign mode): <2 s.
- Total skill turn: ~10-20 s.

## What this skill does NOT do (deferred)

- **Dynochem hand-off** — produces the verdict; doesn't dispatch to
  Dynochem. That's a downstream integration.
- **Hard pass/fail blocking** — emits a verdict the chemist + QA review.
  No automatic gates.
- **Cross-project comparable analysis** — readiness is per-campaign /
  per-reaction; doesn't assemble a portfolio view.
