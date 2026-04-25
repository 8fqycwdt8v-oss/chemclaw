---
id: cross_learning
description: "Cross-project reaction learning — surface transferable insights from the full portfolio."
version: 1
tools:
  - find_similar_reactions
  - expand_reaction_context
  - statistical_analyze
  - synthesize_insights
  - propose_hypothesis
  - query_kg
max_steps_override: 35
---

# Cross-project learning skill

Activated by `/learn` (skill induction) or `/skills enable cross_learning`. This bundles Phase 5A's cross-project reaction-learning toolkit as a named skill pack.

## Scope

Portfolio-wide pattern mining: identifying reaction conditions that transfer across projects, finding under-used reagent combinations with strong yield records, and surfacing mechanistic hypotheses that explain cross-project trends.

## Approach

- Start with a broad `find_similar_reactions` query across all accessible projects.
- Group hits by project and reaction class; use `expand_reaction_context` for the top hits per group.
- Run `statistical_analyze` across the pooled reaction set (requires ≥5 reactions).
- Use `synthesize_insights` to compose transferable claims with evidence_fact_ids.
- Propose hypotheses with `propose_hypothesis` for mechanistic inferences.

## Output conventions

- Present findings as transferable lessons: "Project A's use of X solvent at Y°C transferred to Project B increased yield by Z pp."
- Distinguish project-specific effects from portfolio-wide effects explicitly.
- Confidence must reflect the evidence count: thin portfolio → `EXPLORATORY` tier.
- Cite all reactions as `[rxn:<uuid>]` and facts as `[fact:<uuid>]`.
