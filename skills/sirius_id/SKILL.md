---
id: sirius_id
description: "MS-based unknown identification using SIRIUS 6 + CSI:FingerID + CANOPUS."
version: 1
tools:
  - identify_unknown_from_ms
  - canonicalize_smiles
  - search_knowledge
  - query_kg
  - propose_hypothesis
max_steps_override: 20
---

# SIRIUS ID skill

Activated when the user uploads MS2 data or asks to identify an unknown compound.
Also triggered by `/identify` or `/ms-id`.

## When to use this skill

- Unknown impurity identification from LC-MS/MS data.
- Metabolite ID from plasma/urine samples.
- Structure elucidation of biosynthetic pathway intermediates.
- Any question where the user provides m/z values and a precursor mass.

## Approach

1. Extract `ms2_peaks` (list of {m_z, intensity} pairs) and `precursor_mz` from the user's data.
   - If the user pastes a peak table, parse it into the correct format.
   - If the ionization mode is not stated, assume `positive` and inform the user.
2. Call `identify_unknown_from_ms` with the peak list.
   - Latency: ~60–120 s. Communicate this to the user before calling.
3. Inspect the returned candidates:
   - Report the top-5 by CSI:FingerID score.
   - Include ClassyFire classification (kingdom, superclass, class).
4. Canonicalize the top candidate SMILES with `canonicalize_smiles` for downstream use.
5. Use `search_knowledge` to find any documented occurrence of the candidate in the user's project documents or SOPs.
6. Use `query_kg` to check if the candidate compound is already in the KG as a known impurity or metabolite.
7. If the top candidate matches an entry in the KG, propose a hypothesis via `propose_hypothesis` connecting the MS identification to the KG fact.

## Output conventions

- Present candidates as: rank | SMILES | name/formula | CSI score | ClassyFire class.
- State confidence level: "High confidence" (score > 0), "Tentative" (score 0 to -0.5), "Low confidence" (score < -0.5).
- Include a caveat: "SIRIUS identification requires MS2 spectra calibrated within 5 ppm mass accuracy for reliable results."

## Latency expectations

- `identify_unknown_from_ms`: ~60–120 s (SIRIUS 6 JVM + database search).
