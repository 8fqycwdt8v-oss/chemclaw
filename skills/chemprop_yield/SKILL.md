---
id: chemprop_yield
description: "Yield prediction over a reaction set using chemprop v2 MPNN with uncertainty quantification."
version: 1
tools:
  - predict_reaction_yield
  - predict_molecular_property
  - find_similar_reactions
  - statistical_analyze
  - search_knowledge
max_steps_override: 20
---

# Chemprop Yield skill

Activated when the user asks to predict yield for a reaction set or `/yield <rxn_smiles>`.

## Approach

1. If the user provides reaction SMILES directly, call `predict_reaction_yield` with the list.
2. If the user asks for yield on similar reactions from the portfolio:
   a. Use `find_similar_reactions` to retrieve the reaction set.
   b. Pass the `rxn_smiles` list to `predict_reaction_yield`.
3. If property prediction is requested (logP, logS, mp, bp), use `predict_molecular_property`.
4. Report predictions with uncertainty (std). Flag predictions where `std / predicted_yield > 0.3` as low-confidence.
5. Use `statistical_analyze` to rank-order features affecting yield across a reaction set.
6. Use `search_knowledge` to cross-reference predicted conditions with documented best practices.

## Output conventions

- Present predicted yield as `X% ± Y%` (mean ± 1 std).
- State the model version (field: `model_id`).
- If `std` is unavailable or 0, note that uncertainty is not quantified for this model.
- Recommended action: if predicted yield < 60%, suggest condition optimization via the `askcos_route` skill.

## Latency expectations

- `predict_reaction_yield`: ~5–15 s per batch of 100.
- `predict_molecular_property`: ~5–10 s per batch of 100.
