---
id: xtb_conformer
description: "GFN2-xTB + CREST conformer ensemble for stereo, atropisomerism, or ring-flip questions."
version: 1
tools:
  - canonicalize_smiles
  - compute_conformer_ensemble
  - search_knowledge
  - propose_hypothesis
max_steps_override: 15
---

# xTB Conformer skill

Activated when the user asks about conformational flexibility, atropisomerism, or ring geometry.
Also triggered by `/conformer <smiles>`.

## When to use this skill

- Stereocentre ambiguity: "Which diastereomer is more stable?"
- Atropisomerism: "What is the rotational barrier for this biaryl?"
- Ring flipping: "What is the preferred chair conformation?"
- Macrocyclic geometry: "Which conformer closes the macrolactam ring?"

## Approach

1. Canonicalize the SMILES with `canonicalize_smiles`.
2. Call `compute_conformer_ensemble` with appropriate `n_conformers` (default 20; use 50+ for macrocycles).
   - Method `GFN2-xTB` for drug-like molecules; `GFN-FF` for large macrocycles (faster).
3. Summarize the ensemble:
   - List top-5 conformers by Boltzmann weight.
   - Report energy span (highest − lowest conformer, in kcal/mol: multiply Hartree difference by 627.509).
   - Flag if the lowest-energy conformer has weight > 0.8 (likely single dominant conformer).
4. Use `search_knowledge` to find any documented crystal structures or NMR data for this compound class.
5. If mechanistic inference is needed, call `propose_hypothesis` with appropriate cited fact_ids.

## Output conventions

- Energy values in kcal/mol relative to the global minimum.
- Boltzmann weights reported as percentages.
- State which method and `n_conformers` were used.
- Note if CREST failed to find multiple conformers (single-conformer result).

## Latency expectations

- `compute_conformer_ensemble`: ~30–60 s for typical drug-like molecule (MW < 500).
- Larger molecules (MW > 800) may take 2–5 min; communicate this to the user before calling.
