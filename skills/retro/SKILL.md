---
id: retro
description: "Retrosynthesis route proposal — find similar reactions, expand context, propose routes."
version: 1
tools:
  - find_similar_reactions
  - expand_reaction_context
  - canonicalize_smiles
  - search_knowledge
  - query_kg
  - propose_hypothesis
max_steps_override: 30
---

# Retrosynthesis skill

Activated when the user asks "how do I make X" or `/retro <smiles>`.

## Approach

- Canonicalize the target with `canonicalize_smiles` first.
- Search similar reactions across the user's portfolio with `find_similar_reactions`.
- Expand the top-3 hits with `expand_reaction_context` to gather reagents, conditions, outcomes, and failures.
- Look up SOPs and method validations via `search_knowledge` for the chosen route.
- Use `query_kg` to surface any known incompatibilities, hazard notes, or vendor restrictions on the proposed reagents.
- Compose a ranked route table with: reaction ID, yield range, key conditions, risks, and references.
- Propose a hypothesis via `propose_hypothesis` for any mechanistic inference that is not directly evidenced.
- Cite reactions as `[rxn:<uuid>]` and document chunks as `[doc:<uuid>:<chunk_index>]`. Do not fabricate IDs.

## Output conventions

- Present routes in descending order of expected yield confidence.
- Flag any `EXPLORATORY`-tier facts explicitly.
- If fewer than 3 similar reactions exist in the portfolio, state this and suggest a literature search.
