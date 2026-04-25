---
id: askcos_route
description: "Multi-step retrosynthesis route proposal via ASKCOS v2 with AiZynthFinder fallback."
version: 1
tools:
  - canonicalize_smiles
  - propose_retrosynthesis
  - search_knowledge
  - query_kg
  - propose_hypothesis
max_steps_override: 25
---

# ASKCOS Route skill

Activated when the user asks for a retrosynthesis plan or types `/route <smiles>`.

## Approach

1. Canonicalize the target SMILES with `canonicalize_smiles` first.
2. Call `propose_retrosynthesis` to generate multi-step routes.
   - ASKCOS is preferred (lower latency ~10 s); AiZynthFinder is the automatic fallback if ASKCOS times out or returns 503.
   - Use `prefer_aizynth: true` when the user explicitly prefers AiZynthFinder.
3. For the top-3 routes, expand conditions with `search_knowledge` (query: reaction class + conditions).
4. Use `query_kg` to surface known reagent incompatibilities, hazards, or vendor restrictions on proposed reagents.
5. Compose a ranked route table:
   - Columns: step index, reaction SMILES, expected score, conditions, risks, references.
   - Order by descending `total_score`.
6. If mechanistic inference is required, call `propose_hypothesis` with cited fact_ids from KG lookup.

## Output conventions

- Present routes in descending total_score order.
- Flag `EXPLORATORY`-tier facts explicitly.
- Cite reactions as `[rxn:<uuid>]`, documents as `[doc:<uuid>:<chunk_index>]`.
- If ASKCOS fell back to AiZynthFinder, state the reason (e.g., "ASKCOS model not loaded").
- If fewer than 2 routes are returned, state this and recommend a literature search.

## Latency expectations

- ASKCOS: ~10 s per call.
- AiZynthFinder: ~20–40 s per call.
- Total skill: ~30–60 s for the full route + condition expansion.
