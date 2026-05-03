---
id: closed-loop-optimization
description: "Run a closed-loop reaction-optimization campaign: define factors → propose batch → measure → feed back → propose again. BoFire-driven Bayesian optimization."
version: 1
tools:
  - canonicalize_smiles
  - recommend_conditions
  - design_plate
  - start_optimization_campaign
  - recommend_next_batch
  - ingest_campaign_results
  - predict_yield_with_uq
  - manage_todos
  - find_similar_reactions
  - query_kg
max_steps_override: 30
---

# Closed-Loop Optimization skill

Activated when the user asks "optimize this reaction", "propose next 8 wells",
"start a BO campaign on synthetic_step S", or feeds measured results back
("here are yields for the last batch — propose the next").

## Approach

The user typically engages this skill across multiple turns. Use
`manage_todos` to track campaign state explicitly so the chemist sees progress.

### Initial setup (round 0)

1. **Canonicalize inputs.**
2. **Discover prior data.** If `nce_project_internal_id` is set in session
   context, call `find_similar_reactions` for any existing data on the same
   chemotype.
3. **Define factor space.** Either from a prior `design_plate` call (whose
   `domain_json` is the factor spec) OR from the chemist's explicit inputs.
4. **Start the campaign.** Call `start_optimization_campaign`:
   - `nce_project_internal_id`: required — the project the campaign belongs
     to. Must be one the user has access to (RLS-checked at insert time).
   - `factors`: continuous variables (temperature_c, loading_mol_pct,
     time_min, etc.)
   - `categorical_inputs`: catalyst, base, solvent
   - `outputs`: typically `[{name: "yield_pct", direction: "maximize"}]`
   - `strategy: "SoboStrategy"`, `acquisition: "qLogEI"` (defaults).
5. Save the returned `campaign_id` in the manage_todos checklist for the
   chemist to reference in subsequent turns.

### Iterative round (round n+1)

1. **Propose batch.** `recommend_next_batch(campaign_id, n_candidates=8)`.
   - When `n_observations < 3`, returns space-filling random samples.
   - When `n_observations >= 3`, fits a SoboStrategy with qLogEI and proposes
     the next batch.
2. **Render proposals** as a markdown table. Include `used_bo` flag.
3. **Optional virtual ranking.** Call `predict_yield_with_uq` (Z3) on the
   proposed conditions. Annotate each proposal with ensemble_mean ± std for
   chemist confidence-checking.
4. The chemist runs the experiments, comes back with results.

### Ingest round (after the chemist measures)

1. **Ingest measured outcomes.** `ingest_campaign_results(round_id, measured_outcomes)`.
2. Confirm: "Recorded N outcomes for round_index R. Run /optimize again for
   the next batch."

## Output conventions

- Always show `used_bo` when proposing — it tells the chemist whether the
  recommendation was data-driven or cold-start.
- Cite the campaign as `[campaign:<uuid>]` and round as `[round:<uuid>]`.
- When `n_observations < 3`, explain: "Cold start — returning a space-filling
  random batch. After 3+ measured rounds the BO surrogate kicks in."
- For each round emit the BoFire `Domain` reference so a subsequent agent
  invocation can reproduce the campaign state from canonical Postgres.

## Latency expectations

- start_optimization_campaign: ~2 s (build_domain + INSERT).
- recommend_next_batch (cold start): ~1-2 s.
- recommend_next_batch (warm BO, 4-8 candidates): ~5-15 s (GP fit + qLogEI).
- ingest_campaign_results: <1 s.
- Total round turn: ~10-20 s.

## What this skill does NOT do (deferred)

- **Multi-objective Pareto** (yield × selectivity × PMI × greenness × safety)
  — Z6.
- **Multi-task BO** across NCE projects — needs `cross_project_consent` flag
  and is gated behind data-leak review.
- **Hardware integration** (PyLabRobot, Chemspeed) — out of scope; agent
  hands the chemist proposals; chemist runs experiments.
- **Active-learning convergence detection** — chemist judges when to mark
  the campaign `completed`. The harness doesn't auto-stop.
