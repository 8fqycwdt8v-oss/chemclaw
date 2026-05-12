---
id: hplc-method-optimization
description: "Run a closed-loop HPLC method-optimization campaign: pick columns from the catalogue, define eluent / gradient / flow / temperature factors, propose batch via BoFire BO, materialize methods, ingest measured chromatographic-response-function results, repeat. Builds on the same optimization_campaigns / optimization_rounds substrate as closed-loop reaction optimization but with chromatography-aware factor encoding (Tanaka-descriptor column choice, hold-ramp-hold gradient parameterization, monotonicity constraint)."
version: 1
tools:
  - canonicalize_smiles
  - query_chrom_columns
  - start_chrom_campaign
  - recommend_next_chrom_batch
  - materialize_chrom_method
  - ingest_campaign_results
  - query_instrument_runs
  - fetch_instrument_run
  - manage_todos
  - query_kg
max_steps_override: 30
---

# HPLC Method Optimization skill

Activated when the user asks to develop or optimize an analytical
HPLC/UHPLC method:

- "develop an HPLC method for {compound|mixture}"
- "optimize the chromatography for impurity profiling on {project}"
- "screen columns for separating {analyte set}"
- "propose the next batch of methods for campaign {id}"
- "ingest these chromatographic results — propose round n+1"

Reuses the same `optimization_campaigns` / `optimization_rounds` substrate
as `closed-loop-optimization`; the chromatography-specific knowledge is in
the BoFire `Domain` (column choice as `CategoricalDescriptorInput` with
Tanaka 6-axis descriptors, hold-ramp-hold gradient parameterization,
`pctB_init <= pctB_final` monotonicity constraint).

## Approach

Use `manage_todos` to track campaign state across the multi-turn cycle.

### Initial setup (round 0)

1. **Catalogue scout.** Call `query_chrom_columns` with the user's
   constraints (e.g. `chemistry_filter=["C18","Phenyl-Hexyl","F5"]`,
   `require_ms_compatible=true`). Returns column ids + Tanaka descriptors.
2. **Decide the eluent system.** Default Tier A binary system:
   - `b_solvent_choices`: `["MeCN","MeOH"]` is a reasonable default; add
     `"IPA"` if the analyte is hydrophobic.
   - `additive_choices`: when detection_mode is MS, **omit TFA** —
     `["FA_0.1pct", "NH4OAc_10mM_pH4.5", "NH4HCO3_10mM_pH9.0"]` are the
     standard set. For DAD-only, `TFA_0.1pct` is fine.
3. **Choose the gradient scheme.** Default `hold_ramp_hold` (5 continuous
   parameters). Use `linear` (4 params) for a tighter cold-start budget.
   `multi_segment` is Phase 4 — not yet available.
4. **Choose objective mode.** Default `single` (Niezen-Desmet CRF as the
   scalar — Phase 2 wires the scorer). `pareto` if the chemist wants to
   trade off resolution × runtime × solvent footprint.
5. **Start the campaign.** Call `start_chrom_campaign`:
   - `campaign_name`: chemist-readable title.
   - `nce_project_internal_id`: required.
   - `columns`: the (id, tanaka) pairs from step 1.
   - `b_solvent_choices`, `additive_choices`, `gradient_scheme`,
     `objective_mode`.
   - `flow_bounds_mLmin`, `T_bounds_C`: defaults `[0.2, 1.0]` and
     `[25, 55]` are conservative — tighten for a specific column class.
6. Save the returned `campaign_id` in `manage_todos` for the chemist.

### Iterative round (round n+1)

1. **Propose batch.** `recommend_next_chrom_batch(campaign_id, n_candidates=4-8)`.
   - `n_observations < 5` → space-filling random samples.
   - `n_observations >= 5` → BO (qLogEI single-objective, qNEHVI multi).
   - `used_bo=true` in the response confirms the warm-BO path fired.
2. **Materialize each proposal as an executable method.** For each
   `proposal_index` in the round, call `materialize_chrom_method` with
   the same `gradient_scheme` used at campaign start. Returns a
   gradient-program table (time_min, pctB) and persists an
   `analytical_methods` row.
3. **Render** the methods as a markdown table for the chemist (column,
   solvent, additive, flow, T, gradient, total runtime).
4. The chemist runs the methods on a method-development pump; results
   land in LOGS-by-SciY.

### Ingest round (after the chemist measures)

1. **Pull peak data.** `query_instrument_runs` filtered to
   `instrument_kind="HPLC"` (or LC-MS) and `since` the round's
   `proposed_at`. Optionally `fetch_instrument_run(uid)` for each.
2. **Score (Phase 2 — pending).** Today the agent computes the
   chromatographic response function manually from the peak list (or
   asks the chemist for a CRF value) and forms `measured_outcomes`.
   Phase 2 wires `score_chromatogram` so the agent can do this end-to-end.
3. **Ingest.** `ingest_campaign_results(round_id, measured_outcomes)`.
4. Confirm: "Recorded N CRF outcomes for round R. Run /optimize-method
   again for the next batch."

## Output conventions

- Always show `used_bo` when proposing — tells the chemist whether the
  recommendation was data-driven or cold-start.
- Cite `[campaign:<uuid>]`, `[round:<uuid>]`, `[method:<uuid>]` on each
  rendered proposal.
- When `n_observations < 5`, explain: "Cold start — returning a
  space-filling random batch. After 5+ measured rounds the BO surrogate
  kicks in (chromatography measurements have more nuisance variability
  per injection than reaction yields)."

## Latency expectations

- start_chrom_campaign: ~2 s.
- recommend_next_chrom_batch (cold start): ~1-2 s.
- recommend_next_chrom_batch (warm BO, 4-8 candidates): ~5-15 s.
- materialize_chrom_method: <1 s per proposal.
- ingest_campaign_results: <1 s.

## What this skill does NOT do (deferred)

- **`score_chromatogram`** (Phase 2) — peak tracker + Niezen-Desmet CRF.
  The MCP returns 501 today; the chemist supplies CRF values manually.
- **Multi-segment gradients with N breakpoints** (Phase 4) — currently
  hold-ramp-hold or linear only.
- **Tier-B ternary eluent** (Phase 4) — binary A/B only.
- **LSS retention warm-start** (Phase 5) — pure black-box BO today.
- **Hardware autonomy** (Phase 6) — agent emits methods, chemist queues
  the runs, LOGS-by-SciY ingests results.
