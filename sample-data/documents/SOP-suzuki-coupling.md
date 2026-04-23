# SOP — Suzuki-Miyaura Coupling (General Procedure)

**Version:** 2.1
**Effective date:** 2026-01-10
**Scope:** NCE-001, NCE-002 (small-molecule development programs)

## 1. Purpose

This SOP describes the standard procedure for Suzuki-Miyaura cross-coupling
of aryl halides with boronic acids at development scale (50 mg – 5 g).

## 2. Precautions

- Perform all reactions under inert atmosphere (N₂ or Ar).
- Pre-degas all solvents by sparging with inert gas for ≥15 minutes.
- Use anhydrous solvents unless the protocol explicitly calls for aqueous co-solvent.

## 3. Standard reagents

| Role | Reagent | Typical loading |
|---|---|---|
| Catalyst | Pd(PPh₃)₄ | 3–5 mol% |
| Base | K₂CO₃ (2.0 equiv) or Cs₂CO₃ (1.5 equiv) | depends on substrate solubility |
| Solvent | Toluene / EtOH / H₂O (3 : 1 : 1) | 0.1–0.2 M in aryl halide |

Pd(dppf)Cl₂ or Pd-PEPPSI variants may be substituted for electron-poor or
sterically encumbered aryl halides. Substitution must be recorded in the
ELN entry.

## 4. Procedure (typical 100 mg scale)

1. Charge a dry round-bottom flask with aryl halide (1.0 equiv), boronic acid
   (1.1–1.3 equiv), and K₂CO₃ (2.0 equiv).
2. Add solvent mixture (5 mL per 100 mg aryl halide).
3. Degas by three freeze-pump-thaw cycles (or 15 min N₂ sparge).
4. Add Pd(PPh₃)₄ (5 mol%) under positive N₂ flow.
5. Heat at 80–85 °C for 12–18 h. Reaction progress by TLC or LC-MS.
6. Cool to rt; partition between EtOAc and water; wash organic layer with brine.
7. Dry over Na₂SO₄, filter, concentrate, purify by silica chromatography.

## 5. Acceptance criteria

- Isolated yield ≥ 50% for electron-neutral substrates.
- HPLC purity ≥ 95% before downstream coupling.
- If yield < 30% or HPLC purity < 90%, initiate troubleshooting checklist
  (Section 7).

## 6. Known failure modes

- **Protodehalogenation** when Pd source is hygroscopic or freshly-opened
  K₂CO₃ is wet. Mitigation: pre-dry K₂CO₃ at 120 °C for 2 h; use flame-dried
  glassware.
- **Homocoupling** of boronic acid when substrate is electron-rich aryl
  iodide. Mitigation: reduce Pd loading to 2 mol% and add 1 equiv of the
  aryl halide slowly over 1 h.
- **Sluggish conversion** on ortho-substituted substrates. Mitigation:
  switch to Pd(dppf)Cl₂ or Pd-XPhos; raise temperature to 100 °C.

## 7. Troubleshooting checklist

- [ ] Verify Pd catalyst lot and expiry.
- [ ] Confirm solvent anhydrous (Karl Fischer < 50 ppm water).
- [ ] Check base purity and dryness.
- [ ] Verify substrate purity by LC-MS before charging.
- [ ] Review stirring efficiency; Pd particles may agglomerate on inadequate stirring.

## 8. References

- Miyaura, N.; Suzuki, A. *Chem. Rev.* **1995**, *95*, 2457.
- Internal report INT-2025-018 (NCE-001 route development).
