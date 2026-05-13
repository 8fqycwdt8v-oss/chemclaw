---
id: hplc-method-optimization
description: "Run a closed-loop HPLC method-optimization campaign: pick columns from the catalogue, define eluent / gradient / flow / temperature factors, propose batch via BoFire BO, materialize methods, score measured chromatograms (Niezen-Desmet CRF), ingest, repeat. Supports single-objective (CRF) and multi-objective (resolution × runtime × solvent footprint) modes, linear / hold-ramp-hold / multi-segment gradient parameterization, binary or ternary eluent, and LSS-simulated cheap-fidelity pre-screening. Built on the optimization_campaigns / optimization_rounds substrate with chromatography-aware factor encoding (Tanaka-descriptor column choice, monotonicity-constrained gradients)."
version: 2
tools:
  - canonicalize_smiles
  - query_chrom_columns
  - start_chrom_campaign
  - recommend_next_chrom_batch
  - materialize_chrom_method
  - ingest_chrom_results
  - extract_chrom_pareto_front
  - simulate_chrom_retention
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
- "give me the Pareto front for campaign {id}"

Reuses the same `optimization_campaigns` / `optimization_rounds` substrate
as `closed-loop-optimization`; the chromatography-specific knowledge is in
the BoFire `Domain` (column choice as `CategoricalDescriptorInput` with
Tanaka 6-axis descriptors, monotonicity-constrained gradient
parameterization) and in `mcp_chrom_method_optimizer`'s scoring endpoints.

## Approach

Use `manage_todos` to track campaign state across the multi-turn cycle.

### Initial setup (round 0)

1. **Catalogue scout.** Call `query_chrom_columns` with the user's
   constraints (e.g. `chemistry_filter=["C18","Phenyl-Hexyl","F5"]`,
   `require_ms_compatible=true`). Returns column ids + Tanaka descriptors
   + operating envelopes (`flow_max_mLmin`, `T_max_C`). When you pass the
   columns to `start_chrom_campaign`, narrow `flow_bounds_mLmin` /
   `T_bounds_C` to the *intersection* of the chosen columns' envelopes so
   no proposal exceeds a column's spec.
2. **Decide the eluent system.**
   - Binary (default): `b_solvent_choices = ["MeCN","MeOH"]`; add `"IPA"`
     for hydrophobic analytes. `additive_choices`: when detection is MS,
     **omit TFA** — `["FA_0.1pct","NH4OAc_10mM_pH4.5","NH4HCO3_10mM_pH9.0"]`;
     DAD-only → `TFA_0.1pct` is fine.
   - Ternary (`eluent_mode="ternary"`): the B-channel is a continuous
     MeCN/MeOH mix (`b_meoh_fraction ∈ [0,1]`) — use when MeCN or MeOH
     alone won't separate close-eluting isomers. The `b_solvent` categorical
     is dropped in this mode.
3. **Choose the gradient scheme.** `hold_ramp_hold` (5 params, default),
   `linear` (4 params, tightest cold-start budget), or `multi_segment`
   with `n_segments` breakpoints (2N+1 params; monotonicity of both the
   breakpoint times and the %B trace is enforced by the Domain). Use
   multi-segment only once a simpler scheme plateaus — higher dimension
   slows BO convergence.
4. **Choose objective mode.** `single` (Niezen-Desmet CRF as the scalar —
   resolution × peak count × runtime with a self-adapting time weight) or
   `pareto` (min-resolution `max` × runtime `min` × solvent-PMI `min`;
   uses MoboStrategy + qNEHVI).
5. **(Optional) LSS pre-screen.** If the chemist ran a couple of isocratic
   scouting injections, call `simulate_chrom_retention` with
   `scouting_observations` (per-analyte `(phi, t_R)` pairs) + a candidate
   `gradient_program` + the column dead time `t0_min` to virtually score
   gradients before committing real runs (cheap fidelity).
6. **Start the campaign.** `start_chrom_campaign`:
   - `campaign_name`, `nce_project_internal_id` (required).
   - `columns`: the (id, tanaka) pairs from step 1.
   - `b_solvent_choices`, `additive_choices`, `gradient_scheme`,
     `n_segments`, `objective_mode`, `eluent_mode`.
   - `flow_bounds_mLmin`, `T_bounds_C`: narrow per step 1.
7. Save the returned `campaign_id` in `manage_todos`.

### Iterative round (round n+1)

1. **Propose batch.** `recommend_next_chrom_batch(campaign_id, n_candidates=4-8)`.
   - `n_observations < 5` → space-filling random samples.
   - `n_observations >= 5` → BO (qLogEI single-objective, qNEHVI multi).
   - `used_bo=true` confirms the warm-BO path fired.
2. **Materialize each proposal.** For each `proposal_index`, call
   `materialize_chrom_method` with the same `gradient_scheme` /
   `n_segments` used at campaign start. Returns a (time_min, pctB)
   gradient-program table and persists an `analytical_methods` row.
3. **Render** the methods as a markdown table (column, solvent, additive,
   flow, T, gradient, total runtime).
4. The chemist runs the methods on a method-development pump; the
   resulting datasets land in LOGS-by-SciY.

### Ingest round (after the chemist measures)

1. **Pull peak data.** `query_instrument_runs` filtered to
   `instrument_kind="HPLC"` (or LC-MS) and `since` the round's
   `proposed_at`; `fetch_instrument_run(uid)` for each.
2. **Score + ingest in one step.** `ingest_chrom_results(round_id, runs)`
   where each `runs` entry has `{proposal_index, peaks, targets?,
   runtime_min?, b_solvent?, flow_mLmin?, avg_pctB?}`. The builtin scores
   each chromatogram via the MCP (Niezen-Desmet CRF + min-resolution +
   runtime + solvent-PMI), writes `optimization_rounds.measured_outcomes`,
   and returns the per-proposal scores (and `tracking_confidence` — flag to
   the chemist if it's `"partial"`, i.e. a target compound went missing).
3. Confirm: "Recorded N scored outcomes for round R. Run /optimize-method
   again for the next batch."

### Wrap-up (multi-objective campaigns)

After a few rounds on `objective_mode="pareto"`, call
`extract_chrom_pareto_front(campaign_id)` and present the non-dominated
methods so the chemist picks the resolution / speed / green-ness trade-off.

## Output conventions

- Always show `used_bo` when proposing.
- Cite `[campaign:<uuid>]`, `[round:<uuid>]`, `[method:<uuid>]`.
- When `n_observations < 5`, explain the cold-start (chromatography has
  more nuisance variability per injection than reaction yields).
- For multi-segment gradients, render the full (time, %B) table — the
  curvature is the point.

## Latency expectations

- start_chrom_campaign / materialize_chrom_method: ~1-2 s.
- recommend_next_chrom_batch: ~1-2 s cold start; ~5-15 s warm BO.
- ingest_chrom_results: ~1 s + ~0.5 s per scored run.
- simulate_chrom_retention: <1 s for one gradient; the MCP can score
  thousands of candidates in a single `/seed_candidates_lss` call.

## What this skill does NOT do (deferred)

- **Hardware autonomy** (Phase 6) — the agent emits method files; the
  chemist queues the runs; LOGS-by-SciY ingests results. A future
  `mcp_instrument_<vendor>` adapter with `POST /run_method` closes the
  loop; see `docs/runbooks/chromatography-method-optimization.md`.
- **DAD-spectral-correlation peak tracking** — current tracking matches
  by compound name and m/z only; UV-only datasets after a selectivity
  inversion may report `tracking_confidence: "partial"`.
- **Cost-aware multi-fidelity acquisition** — LSS pre-screening is a
  manual 2-stage workflow today (`simulate_chrom_retention` /
  `/seed_candidates_lss`), not folded into the BO acquisition function.
- **Gradient-scouting LSS fit** — `simulate_chrom_retention` fits LSS from
  *isocratic* scouting observations; the two-gradient-scouting fit method
  is a follow-up.
