---
id: synthegy_retro
description: "Strategy-aware retrosynthesis: rerank askcos/aizynth routes against a natural-language query (e.g. 'early imidazole ring formation', 'avoid Pd catalysis')."
version: 1
tools:
  - canonicalize_smiles
  - propose_retrosynthesis
  - find_similar_reactions
  - expand_reaction_context
  - search_knowledge
  - query_kg
  - propose_hypothesis
max_steps_override: 30
---

# Synthegy Retrosynthesis skill

Activated when the user expresses a **strategic preference** for a retrosynthesis ("plan a route to X with early imidazole ring formation", "find a convergent strategy to Y", "avoid protecting groups", "use only commercially available SMs"), or types `/synthegy <smiles> "<query>"`.

Adapted from Bran et al., *Matter* 2026, [10.1016/j.matt.2026.102812](https://doi.org/10.1016/j.matt.2026.102812). The framework (Synthegy) is **not** a route generator — it is a reranker that scores candidates from external retrosynthesis engines against a strategic query.

## Approach

1. Canonicalize the target with `canonicalize_smiles`.
2. Generate a candidate pool with `propose_retrosynthesis` (askcos by default; pass `prefer_aizynth: true` if the user prefers aizynth or askcos is unavailable). Aim for ≥ 5 candidates so reranking has signal.
3. Optionally augment the pool with `find_similar_reactions` for portfolio-grounded alternatives.
4. For each candidate route, produce a structured score in the format below. Score routes **one at a time** (the paper documents positional bias when multiple routes appear in one prompt).
5. Use `expand_reaction_context`, `search_knowledge`, and `query_kg` to ground claims in the rationale (cite reactions as `[rxn:<uuid>]`, document chunks as `[doc:<uuid>:<chunk_index>]`).
6. Present the top-k routes ranked by score, with the `<analysis>` rationale visible to the user.

## Output convention (paper-compatible)

For each candidate route, emit:

```
<analysis>
[Stepwise analysis of the route in retrosynthetic order — last reaction first, working back to starting materials.
For each step, identify the key transformation, the functional groups involved, and how it aligns with the user's strategic query.
Reference specific aspects of the query when discussing relevance.]
</analysis>

<score>[integer 0–10, where 10 = perfectly aligned with the query]</score>
```

This format mirrors Synthegy's `route_opt` prompt (paper Methods §"Strategy-aware synthesis planning"), so the agent's outputs are directly comparable to the paper's benchmark and Zenodo data ([10.5281/zenodo.19636339](https://doi.org/10.5281/zenodo.19636339)).

## Scoring guidance

When evaluating each route:

1. Identify the key functional groups and structural changes in each reaction.
2. Evaluate how well each reaction aligns with the query's strategic requirements (timing of ring formation, choice of disconnection, protecting-group strategy, etc.).
3. Note whether the route uses any reactions known to be problematic (overuse of protecting groups, low-yielding cyclizations, redundant FGI steps).
4. Consider global feasibility: does the route as a whole satisfy the query?

Reactions are theoretical proposals from a retrosynthesis engine — they have not been bench-validated. Treat scores as **strategic alignment estimates**, not yield predictions.

## Limitations to surface

- **Routes longer than ~20 reactions** degrade in scoring quality (paper Results); say so explicitly when scoring such routes.
- **Misinterpretation of SMILES** is a documented Synthegy failure mode — when in doubt, canonicalize aggressively and double-check the agent's understanding of the structure.
- **Bias toward optimistic feasibility** — Synthegy can over-rank questionable routes. Useful as a *screening* layer; foundation-tier promotion of any specific route still requires a chemist in the loop.

## Output

A markdown table with columns: rank, route summary (e.g. "5-step convergent via SNAr"), score, key strategic alignment notes, references. Order by descending score.
