---
id: synthegy_feasibility
description: "Score retrosynthesis-route feasibility — yield, side reactions, byproducts, redundant steps. No strategy required."
version: 1
tools:
  - canonicalize_smiles
  - propose_retrosynthesis
  - expand_reaction_context
  - search_knowledge
  - query_kg
max_steps_override: 25
---

# Synthegy Feasibility skill

Activated when the user wants a **route-quality screening** without a specific strategic preference. Examples: "rank these candidate routes by feasibility", "which of these is most likely to give high overall yield?", "is this route practical?".

Adapted from Bran et al., *Matter* 2026, [10.1016/j.matt.2026.102812](https://doi.org/10.1016/j.matt.2026.102812). The feasibility prompt (paper Methods §"Feasibility scoring") was validated against experimentally-realized routes from drug-discovery campaigns — those routes received high feasibility scores in the paper benchmark (Figure 3A).

## Approach

1. Canonicalize the target with `canonicalize_smiles`.
2. Generate or accept a candidate pool. If the user asks for a fresh proposal, call `propose_retrosynthesis`. If the user pastes routes, work with what they provide.
3. For each candidate, score one at a time using the feasibility criteria below.
4. Use `expand_reaction_context`, `search_knowledge`, and `query_kg` to ground specific claims (yields, conditions, hazards).
5. Present the routes ranked by feasibility score with the `<analysis>` rationale.

## Feasibility criteria (paper-aligned)

A highly feasible route:
- Has high overall yield expectation (cumulative yield over all steps).
- Considers potential side reactions and byproducts at each step, with manageable selectivity.
- Avoids unnecessary reactions (redundant FGI, over-protection).
- Uses well-precedented transformations under conditions known to scale.
- Has compatible reagents (no reactivity conflicts, no incompatible functional groups present at each step).

## Output convention (paper-compatible)

```
<analysis>
[Walk the route step by step. For each reaction, comment on:
 - Expected yield (literature precedent if known).
 - Selectivity and major side products.
 - Functional-group compatibility with reagents present.
 - Whether the reaction is unnecessary (could be avoided with a better disconnection).
Conclude with an overall assessment: is the route modern, efficient, and robust?]
</analysis>

<score>[integer 0–10, where 10 = highly feasible, 0 = fundamentally flawed]</score>
```

This format matches Synthegy's `feasibility` prompt verbatim, so scores are comparable to the paper's published evaluations on the four targets in Figure 3.

## Limitations

- Synthegy shows **bias toward optimistic feasibility** (paper Discussion) — calibrate by comparing your scores against the experimentally-validated routes the user can probably retrieve via `search_knowledge`.
- **Score positional bias** — score routes one at a time, not in a single multi-route prompt.
- Score is a *screen*, not a yield prediction. Quantitative yield questions go to `predict_reaction_yield`.

## Output

A markdown table sorted by descending feasibility score. Highlight any route scoring < 4 as "not recommended without major revision" and explain the specific flaws.
