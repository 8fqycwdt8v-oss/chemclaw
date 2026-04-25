---
id: admet_screen
description: "Early-stage ADMET liability screening using ADMETlab 3.0 (119 endpoints per compound)."
version: 1
tools:
  - canonicalize_smiles
  - screen_admet
  - search_knowledge
  - propose_hypothesis
max_steps_override: 20
---

# ADMET Screen skill

Activated when the user asks about ADMET, drug-likeness, toxicity, or hERG liability.
Also triggered by `/admet <smiles_list>` or `/screen <smiles_list>`.

## Approach

1. Canonicalize each SMILES with `canonicalize_smiles` (batch, up to 50).
2. Call `screen_admet` with the canonicalized list.
3. Parse the 119-endpoint result by ADME category:
   - Absorption: Caco-2 permeability, HIA (human intestinal absorption), oral bioavailability.
   - Distribution: VD (volume of distribution), PPB (plasma protein binding), BBB penetration.
   - Metabolism: CYP3A4/2D6/2C9 substrate/inhibitor status.
   - Excretion: renal clearance, T½ (half-life).
   - Toxicity: hERG (cardiac), AMES (mutagenicity), hepatotoxicity, skin sensitization.
4. Flag structural alerts (field: `alerts`) prominently.
5. Use `search_knowledge` for any documented SAR insights on the flagged alerts.
6. If a compound clears all filters, summarize as "No major ADMET flags identified at this screen stage."
7. For lead series comparison, call `propose_hypothesis` to propose an SAR hypothesis linking structural features to ADMET profiles.

## Traffic-light summary

| Flag | Criterion |
|---|---|
| RED (STOP) | hERG IC50 < 1 µM, AMES positive, hepatotoxicity probability > 0.8 |
| AMBER (CAUTION) | VD > 20 L/kg, T½ < 1 h, CYP3A4 strong inhibitor |
| GREEN (PROCEED) | No RED or AMBER flags |

State traffic-light status per compound at the top of the response.

## Latency expectations

- `screen_admet`: ~5–15 s per batch of 50 via hosted API; ~30–60 s via local model.
