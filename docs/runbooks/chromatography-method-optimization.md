# Runbook: chromatography method optimization

Operator-facing guide for the BO-driven HPLC/UHPLC method-optimization
loop (`mcp_chrom_method_optimizer`, port 8019; `hplc-method-optimization`
skill). Design rationale: `docs/plans/bo-chromatography-method-optimization.md`.
Implementation plan / phase status: `docs/plans/bo-chromatography-implementation-plan.md`.

## When to use it

You have a separation problem (assay + impurities, isomers, a forced-deg
mixture) and want a fit-for-purpose RP-HPLC method without a manual
column/solvent/gradient sweep. The agent runs a closed loop: propose a
batch of methods → you run them on a method-development pump → results land
in LOGS-by-SciY → the agent scores them (Niezen-Desmet CRF) and proposes
the next batch. Single-objective (CRF) or multi-objective (resolution ×
runtime × solvent footprint) Pareto mode.

Not for: HILIC / SFC / IEX / SEC method dev (RP only), charge-variant or
aggregation methods, or 2D-LC.

## Prerequisites

- `make up.full` (or at least Postgres + `mcp-chrom-method-optimizer` on
  the `chemistry` compose profile + `mcp-logs-sciy` on the `sources`
  profile).
- `db.init` applied — gives `column_inventory` (17-column seed with Tanaka
  6-axis descriptors) and `analytical_methods`.
- A method-development LC (the agent emits method files; an operator queues
  the runs — Phase 6 hardware-in-loop is not yet wired, see below).
- The user has `user_project_access` for the NCE project the campaign
  belongs to (campaigns are RLS-scoped).

## Workflow

1. **Scout columns.** `chemclaw chat "screen orthogonal columns for
   separating <mixture> by LC-MS"` → the agent calls `query_chrom_columns`
   (filter by chemistry / vendor / MS-compatibility), narrows the flow /
   temperature bounds to the intersection of the chosen columns' specs.
2. **Start the campaign.** The agent calls `start_chrom_campaign` with the
   column set, eluent choices (binary MeCN/MeOH/IPA, or `eluent_mode=
   ternary` for a continuous MeCN/MeOH mix), gradient scheme
   (`hold_ramp_hold` default; `linear` for a tight budget; `multi_segment`
   with N breakpoints once a simpler scheme plateaus), and
   `objective_mode` (`single` CRF or `pareto`). Note the `campaign_id`.
3. **Get round 0 methods.** `recommend_next_chrom_batch` → space-filling
   batch (cold start, `used_bo=false`). `materialize_chrom_method` for each
   proposal → executable (time, %B) tables; each persists an
   `analytical_methods` row.
4. **Run the batch.** Queue the materialized methods on the LC; let them
   run (overnight is fine). Results ingest into LOGS-by-SciY automatically.
5. **Ingest results.** `chemclaw chat "ingest the results for round <id>"`
   → the agent pulls the datasets (`query_instrument_runs`), calls
   `ingest_chrom_results` (scores each chromatogram, writes
   `measured_outcomes`). Watch for `tracking_confidence: "partial"` — that
   means a target compound went missing (co-elution / selectivity
   inversion); the agent will flag it.
6. **Iterate.** Repeat 3–5. From the 6th measured method on, the BO
   surrogate kicks in (`used_bo=true`); convergence to baseline resolution
   is typically 10–35 injections (cf. Boelrijk 2023 / Gloria 2024).
7. **Pick the method.** On a `pareto` campaign, `extract_chrom_pareto_front`
   gives the non-dominated set — the agent presents the resolution / speed
   / green-ness trade-offs; you pick one. Mark it `is_optimised` on the
   `analytical_methods` row when satisfied.

### Optional: LSS cheap-fidelity pre-screen

If you ran 2+ isocratic scouting injections, hand the agent the per-analyte
`(φ, t_R)` pairs + the column dead time `t0`; `simulate_chrom_retention`
(and the MCP's `/seed_candidates_lss`) virtually score thousands of
candidate gradients in seconds so round 0 starts from LSS-ranked
candidates rather than pure space-filling. Caveat: LSS coefficients are
condition-specific — keep the same column / B-solvent / additive /
temperature as the scouting runs.

## Objectives & gradient parameterization (what's being optimized)

- **CRF (single-objective default)**: Niezen-Desmet 2024 self-adaptive CRF
  — `Σ_pairs min(Rs/Rs_target, 1) + λ(solvedness)·(t_target − t_R_last)/t_target
  + 0.1·n_peaks`. The time-penalty weight `λ` stays ~0 until resolution
  targets are essentially met, then grows — so the optimizer resolves
  first, then shortens. This avoids the reward-hacking of fixed-weight
  Berridge / Watson-Carr CRFs.
- **Pareto (multi-objective)**: `min_resolution` (maximize) ×
  `runtime_min` (minimize) × `solvent_pmi_g` (minimize, ≈ flow × runtime
  × ρ × avg-%B × 1.75 for re-equilibration).
- **Gradient**: `linear` (pctB_init, t_grad, pctB_final, t_hold_final);
  `hold_ramp_hold` (+ t_hold_init); `multi_segment` (pctB_init, then N
  (t_break_i, pctB_break_i), then t_hold_final — chained monotonicity
  constraints keep both the breakpoint times and the %B trace
  non-decreasing). Per-column flow / temperature caps are respected by
  narrowing the Domain bounds at campaign start.

### Caveats / known limitations

- **Multi-segment gradients are strictly non-decreasing in %B.** The
  monotonicity `LinearInequalityConstraint`s rule out gradient programs
  with deliberate dips mid-run (e.g. ramp to 60 %B, dip back to 40 %B
  to elute a polar impurity, ramp again to 95 %B). Such reverse-gradient
  patterns are uncommon in production methods but real in some
  forced-degradation campaigns; the workaround is to run two
  optimisation passes (one per monotonic sub-region) or drop to
  `hold_ramp_hold` if a single inflection is enough.
- **DAD-spectral peak tracking matches by cosine similarity ≥ 0.95.**
  For UV-only campaigns where MS isn't available, attach a `spectrum`
  field (flat absorbance array on a fixed wavelength grid) to each
  target compound. Targets without a spectrum *and* without an m/z
  fall back to elution-order in `unknown impurities` mode.
- **LSS simulator assumes a constant plate count N** (default 10 000)
  for peak width — gradient peaks are usually narrower than this
  isocratic estimate (band compression), so the simulator
  *under-resolves* relative to a real injection. Good enough for
  *ranking* candidate gradients; do not trust absolute resolution
  predictions.
- **`CHROM_MIN_OBSERVATIONS_FOR_BO`** (env var) overrides the
  cold-start / warm-BO boundary (default 5). Set this once empirical
  data motivates a different value for a specific analyte class.

## Failure modes / troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `start_chrom_campaign` → 422 `infeasible_domain` | descriptor-shape mismatch, empty categorical, inverted bounds | check the column Tanaka vectors are 6 elements; check `flow_bounds_mLmin[0] < [1]` |
| `build_domain` accepted but `column` is a plain categorical, not descriptor-encoded | every Tanaka descriptor was constant across the chosen columns | pick a more orthogonal column set, or accept one-hot encoding |
| `recommend_next_chrom_batch` keeps returning `used_bo=false` past round 5 | the BoFire strategy fit failed (logged); falls back to random | check `mcp-chrom-method-optimizer` logs; usually a malformed `measured_outcomes` row |
| `ingest_chrom_results` → `tracking_confidence: "partial"` | a target compound co-eluted / inverted under the new conditions | the agent surfaces the missing target; decide whether to keep scoring it or relabel |
| `ingest_chrom_results` → `round_already_ingested` | the round's `measured_outcomes` was already written | start a new round; ingestion is idempotency-guarded |
| simulated CRF (LSS) disagrees badly with the measured run | LSS coefficients fitted under different conditions, or band compression made gradient peaks much narrower than the constant-N estimate | use LSS only for *ranking* candidates, not absolute resolution; re-fit per column class |

## Phase 6 — hardware-in-loop (not yet wired)

Today the agent emits method files and an operator queues the injections.
Closing the loop needs an `mcp_instrument_<vendor>` adapter exposing
`POST /run_method(method_json) → run_id` (Waters Empower / Agilent OpenLab
/ etc.) — then the agent submits methods directly and the
`bo_or_die` synthesis-campaign gate (experiment budget +
no-improvement-rounds) can drive an unattended campaign. The
`mcp_instrument_template` service is the skeleton; tracked in
`BACKLOG.md` and `docs/plans/bo-chromatography-implementation-plan.md`
Phase 6.
