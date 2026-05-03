---
id: qm_pipeline_planner
description: "Compose multi-step QM pipelines (conformer search → optimize → frequencies → descriptor) for screening, ranking, and proposing chemistry decisions."
version: 1
tools:
  - canonicalize_smiles
  - inchikey_from_smiles
  - qm_single_point
  - qm_geometry_opt
  - qm_frequencies
  - qm_fukui
  - qm_redox_potential
  - qm_crest_screen
  - find_similar_compounds
  - classify_compound
  - run_chemspace_screen
  - enqueue_batch
  - inspect_batch
  - workflow_define
  - workflow_run
  - workflow_inspect
  - conformer_aware_kg_query
max_steps_override: 30
---

# QM Pipeline Planner

Activated when the user asks for QM-driven analysis, ranking, or screening:
"rank these ligands by binding strength", "which conformer dominates",
"what's the redox potential of X", "screen this fragment library by ΔG".

## Approach

ChemClaw exposes the full xTB / g-xTB / sTDA-xTB / IPEA-xTB capability
surface (Phase 2) plus CREST conformer / tautomer / protomer screens
(mcp-crest). Every QM call is cached in `qm_jobs` keyed by deterministic
SHA-256 — repeat calls cost ~50 ms.

### 1. Canonical pipeline templates

For most "rank N compounds by Y" questions, build a workflow with the
shape below and dispatch via `workflow_define` + `workflow_run`.

**Conformational free-energy ranking**
1. `qm_crest_screen mode=conformers` (CREST ensemble; cached).
2. `qm_geometry_opt method=GFN2 threshold=tight` on the lowest-energy
   conformer.
3. `qm_frequencies method=GFN2` to get ZPE / G298 — needed for free
   energies, not just SCF.
4. Rank the candidate set by `thermo.g298` from step 3.

**Reactivity ranking (electrophilic / nucleophilic sites)**
1. `qm_geometry_opt`.
2. `qm_fukui method=GFN2` on the optimized geometry.
3. The highest f+ atom is the predicted nucleophilic-attack site.

**Redox ranking**
1. `qm_geometry_opt method=GFN2 solvent_model=alpb solvent_name=water`.
2. `qm_redox_potential reference=SHE`.
3. Sort by `redox_potential_V`.

### 2. Picking the method

- **GFN2 (default)**: workhorse for most main-group and TM-light molecules.
- **g-xTB**: try when GFN2 over-stabilizes hypervalent / strained systems.
- **GFN-FF**: only for >300-atom systems when GFN2 is too slow; do not
  use for energy comparisons across different bonding patterns.
- **sTDA-xTB**: excited states only.
- **IPEA-xTB**: redox / vertical IE / EA only.
- **CREST**: conformer / tautomer / protomer enumeration is ALWAYS CREST.

### 3. Solvation

When the chemistry is solvent-sensitive (anion stability, redox, polar
intermediates), pass `solvent_model='alpb'` (or `'gbsa'`/`'cpcmx'`) and a
real solvent name (`'water'`, `'dmso'`, `'thf'`, …). Skipping solvation
on charged species gives misleading energies.

### 4. Composing as a workflow (recommended for ≥3 candidates)

```json
{
  "name": "ligand-binding-rank",
  "steps": [
    {"id": "fetch", "kind": "tool_call", "tool": "find_similar_compounds",
     "args": {"smiles": "<seed>", "k": 30, "fingerprint": "morgan_r2"}},
    {"id": "screen", "kind": "tool_call", "tool": "run_chemspace_screen",
     "args": {
       "name": "ligand-rank",
       "candidates": {"from": "list", "inchikeys": ["<from steps.fetch>"]},
       "scoring_pipeline": [
         {"kind": "qm_geometry_opt", "params": {"method": "GFN2", "threshold": "tight"}},
         {"kind": "qm_frequencies", "params": {"method": "GFN2"}}
       ],
       "top_k": 10
     }},
    {"id": "wait", "kind": "wait",
     "for": {"batch_id": "steps.screen.batch_id"},
     "timeout_seconds": 1800}
  ]
}
```

Dispatch with `workflow_define` then `workflow_run`. Poll progress with
`workflow_inspect` and `inspect_batch`.

### 5. When to skip the workflow

For one-off questions about a single molecule (e.g. "what's the HOMO-LUMO
gap of compound X?"), call the QM tool directly. Workflows are for
≥3-step pipelines you'd reuse, or for >5-candidate screens.

### 6. Reading results

QM tools return `{job_id, cache_hit, energy_hartree, …}`. The persisted
result is fully queryable via `conformer_aware_kg_query`:
- `query='compounds_with_calculation'` — list every compound with a job
  in a given (method, task).
- `query='lowest_conformer_energy'` — sorted by lowest conformer.
- `query='calculation_history_for_compound'` — bi-temporal audit trail
  including superseded jobs (valid_to ≠ NULL).

### 7. Promoting a successful workflow to a tool

After a screen returns useful results that you'd rerun next session, call
`promote_workflow_to_tool` to forge a reusable named tool from the
workflow definition. The agent will be able to call it directly by name
in future sessions without re-defining the JSON DSL.

## Examples

- *"Rank these 5 phosphine ligands by their binding free energy to Pd."*
  → CREST conformers per ligand (cached), GFN2 opt + freq, sort by G298.

- *"Which redox mediator should I pair with this anode?"*
  → IPEA-xTB redox potentials in your target solvent; sort and explain
  the V vs SHE ordering.

- *"Where will this azide tautomer protonate first?"*
  → CREST `protomers`, sort by Boltzmann weight, surface the dominant
  protomer + report Δenergy.
