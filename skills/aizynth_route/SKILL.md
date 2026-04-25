---
id: aizynth_route
description: "Retrosynthesis tree builder via AiZynthFinder — faster and cheaper than ASKCOS."
version: 1
tools:
  - canonicalize_smiles
  - propose_retrosynthesis
  - search_knowledge
  - query_kg
max_steps_override: 20
---

# AiZynthFinder Route skill

An alternative retrosynthesis skill that goes directly to AiZynthFinder, bypassing ASKCOS.
Prefer this skill when:
- ASKCOS is known to be unavailable or slow.
- The question is early-stage and a fast approximate route suffices.
- The user explicitly types `/aizynth <smiles>`.

## Approach

1. Canonicalize the target SMILES with `canonicalize_smiles`.
2. Call `propose_retrosynthesis` with `prefer_aizynth: true`.
   - AiZynthFinder returns a tree (in-stock ratio, score) rather than individual step scores.
3. Parse the tree to extract the synthetic sequence (leaf → root).
4. Search for known conditions and literature precedent via `search_knowledge`.
5. Use `query_kg` to flag known incompatibilities.
6. Present a route summary with in_stock_ratio and score.

## Output conventions

- State `in_stock_ratio` for each route (fraction of required building blocks in virtual stock).
- Highlight routes with `in_stock_ratio >= 0.8` as "commercially accessible".
- If no routes are found, suggest relaxing the stock filter or increasing `max_iterations`.

## Latency expectations

- AiZynthFinder: ~20–40 s per call.
