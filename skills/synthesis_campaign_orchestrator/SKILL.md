---
id: synthesis_campaign_orchestrator
description: "Drive an autonomous synthesis campaign end-to-end. Classifies the user's intent into one of {single_experiment | library_synthesis | screening | bo_campaign | bo_or_die}, creates a synthesis_campaigns row + per-kind step DAG, then advances the DAG by dispatching to the right specialist skill / builtin at each step. Resumable across sessions."
version: 1
tools:
  - canonicalize_smiles
  - inchikey_from_smiles
  - list_synthesis_campaigns
  - start_synthesis_campaign
  - get_synthesis_campaign
  - add_synthesis_campaign_step
  - update_synthesis_campaign_step
  - advance_synthesis_campaign
  - record_synthesis_campaign_outcome
  - manage_todos
  - ask_user
  - propose_retrosynthesis
  - find_similar_reactions
  - expand_reaction_context
  - recommend_conditions
  - assess_applicability_domain
  - score_green_chemistry
  - predict_reaction_yield
  - predict_yield_with_uq
  - generate_focused_library
  - run_chemspace_screen
  - find_matched_pairs
  - find_similar_compounds
  - design_plate
  - start_optimization_campaign
  - recommend_next_batch
  - ingest_campaign_results
  - extract_pareto_front
  - compute_conformer_ensemble
  - qm_frequencies
  - qm_fukui
  - qm_redox_potential
  - qm_crest_screen
  - elucidate_mechanism
  - enqueue_batch
  - inspect_batch
  - kick_workflow_and_wait
  - query_eln_experiments
  - query_eln_canonical_reactions
  - fetch_eln_canonical_reaction
  - query_instrument_runs
  - query_kg
  - search_knowledge
  - synthesize_insights
  - compute_confidence_ensemble
max_steps_override: 60
---

# Synthesis Campaign Orchestrator

Activated by `/synthesize <description>` and whenever the user asks to
"synthesize molecule X", "build a library around scaffold Y", "screen these
conditions", "run a BO campaign", or "run a BO-or-die optimisation".

You drive the campaign **autonomously** via the `synthesis_campaigns` umbrella
state-machine. The state lives in Postgres, so you survive session restarts —
on every invocation, `list_synthesis_campaigns` is your first stop.

## Campaign kinds

| kind | When to choose | Goal payload | Policy payload |
|---|---|---|---|
| `single_experiment` | One target molecule, retro+conditions+predict. | `{ target_smiles, target_inchikey?, max_routes?, max_steps? }` | `{ readiness_floor: 'pilot' \| 'scale', auto_advance: true }` |
| `library_synthesis` | Build N analogues around a scaffold. | `{ scaffold_smiles? \| scaffold_smarts?, library_size, design_strategy }` | `{ readiness_floor, auto_advance }` |
| `screening` | HTE plate of one reaction over a condition space. | `{ reaction_smiles, factor_space, plate_format: 24\|96\|384\|1536 }` | `{ auto_advance, readiness_floor }` |
| `bo_campaign` | Closed-loop Bayesian optimisation, no death gate. | `{ reaction_smiles, objectives, factors, max_rounds, target_yield_pct? }` | `{ bo_acquisition, max_concurrent_steps }` |
| `bo_or_die` | BO with a hard die gate (budget cap or N rounds w/o improvement). | bo_campaign + `{ budget_max_experiments, die_after_no_improvement_rounds }` | + `{ abort_on_die: true }` |

## Operating loop

1. **Resume first.** Call `list_synthesis_campaigns({ status: ['proposed','active','awaiting_measurement','paused'], only_mine: true })`. If the user is referring to an in-flight campaign, fetch it with `get_synthesis_campaign` and skip to step 4.
2. **Classify.** Read the user's request. Pick exactly one `kind` from the table above. If ambiguous, call `ask_user` once with a clarifying question listing the five kinds.
3. **Start.** Call `start_synthesis_campaign({ nce_project_internal_id, kind, name, goal, policy, seed_playbook: true })`. The playbook seeds the canonical step list for that kind. Cite the new campaign as `[campaign:<uuid>]` in your response.
4. **Advance loop.**
   - Call `advance_synthesis_campaign({ campaign_id, claim: true })`.
   - If `decision == 'next_step'`: dispatch the recommended_tools for that step's `kind` (see playbook below). When the dispatched tool returns, call `update_synthesis_campaign_step` with `status='completed'`, `outputs`, and (when applicable) `ref_table` + `ref_id` pointing at the leaf artifact (`optimization_rounds` row, `chemspace_screens` id, `mock_eln.entries` uid, `task_batches` id, etc.). Then loop back to `advance_synthesis_campaign`.
   - If `decision == 'no_ready_steps'`: report waiting state to the user. If a `measurement_wait` step is in progress, call `ask_user` for the measurement results — when they arrive, mark that step completed and continue.
   - If `decision == 'campaign_died'`: cite the rationale, summarise what was learned, and call `record_synthesis_campaign_outcome({ status: 'died', outcome_summary })`.
   - If `decision == 'campaign_completed'`: produce a final summary, then call `record_synthesis_campaign_outcome({ status: 'completed', outcome_summary, measurements? })`.
5. **Bound the loop.** Cap autonomous tool dispatches at the campaign's `max_concurrent_steps` (default 4) per turn. Yield to the user with a status update when the cap is reached or when an `awaiting_measurement` step is open.

## Per-step playbook (what tool/skill maps to each step kind)

| step kind | What you do |
|---|---|
| `retrosynthesis` | `propose_retrosynthesis(target_smiles, max_routes)`. Persist `outputs.routes[]` (each with score, depth, in_stock_ratio). |
| `literature_pull` | `search_knowledge` for the transformation; `fetch_original_document` for cited procedures. |
| `condition_design` | `find_similar_reactions` → `recommend_conditions` → `assess_applicability_domain` → `score_green_chemistry`. Persist top-K candidates. |
| `library_design` | `generate_focused_library` (or `run_chemspace_screen` for catalog). Persist `outputs.library_smiles[]`. |
| `hte_plate_design` | `design_plate({plate_format, factors, n_replicates})`. Persist plate id + well_layout. |
| `bo_round` | If campaign has no `optimization_campaigns` row yet → `start_optimization_campaign(...)` and write its id into the step's `ref_table='optimization_campaigns', ref_id=<uuid>`. Then `recommend_next_batch(campaign_id, n_candidates)`. Persist proposed conditions to `outputs.proposals[]` and the `improved` flag (you'll set it true after the next ingest if best objective improved). |
| `forward_prediction` | `predict_yield_with_uq(rxn_smiles_list)`. Persist `outputs.predictions[]`. |
| `qm_screen` | Compose via `qm_pipeline_planner`-style chain: `compute_conformer_ensemble` → `qm_frequencies` → optionally `qm_fukui`/`qm_redox_potential`. Persist descriptor table. |
| `mechanism_check` | `elucidate_mechanism(reactants_smiles, products_smiles, conditions)`. Persist arrow-pushing trace. |
| `feasibility_assessment` | `assess_applicability_domain` + `predict_yield_with_uq` + `score_green_chemistry`. Persist a single `outputs.verdict ∈ {go, no-go, refine}` plus the supporting numbers. |
| `submit_batch` | `enqueue_batch` (asynchronous) or `kick_workflow_and_wait` (synchronous, ≤5min). Persist `ref_table='task_batches', ref_id=<uuid>`. |
| `measurement_wait` | Call `ask_user` if the chemist runs the experiment, or `inspect_batch` if it's a queued compute job. Loop until the result arrives, then mark completed. |
| `ingest_results` | `ingest_campaign_results(campaign_id, round_id, measured_outcomes)` for BO. For HTE/library: `query_eln_canonical_reactions` to pull the freshly logged ELN entries, then `fetch_eln_canonical_reaction` for each. Persist the row count and best objective; set `outputs.improved=true` if the best objective improved over the prior round. |
| `readiness_gate` | `compute_confidence_ensemble` over the campaign outputs. Pull `pharma-process-readiness` heuristics (yield UQ, AD, greenness, safety) and persist `outputs.readiness ∈ {exploratory, pilot, scale-ready}`. If the policy's `readiness_floor` isn't met, `add_synthesis_campaign_step({ kind: 'condition_design' })` to queue another optimisation round. |
| `die_check` | Pure metadata — `advance_synthesis_campaign` evaluates the BO-or-die guards itself before picking the next step. You don't call any tool here; just `update_synthesis_campaign_step({ status: 'completed' })`. |
| `summary` | `synthesize_insights` over the campaign event log, then `record_synthesis_campaign_outcome({ status: 'completed', outcome_summary, measurements })`. |

## Output conventions

- Cite the umbrella as `[campaign:<uuid>]`, each step as `[step:<uuid>]`, and any leaf artifact as `[round:<uuid>]` / `[screen:<uuid>]` / `[exp:<ELN-…>]`.
- Always state the current `kind`, `status`, `completed_steps / total_steps` in your assistant text.
- Never fabricate yields, AD verdicts, or readiness tiers — they must come from the corresponding tool.
- Never advance past a `measurement_wait` step on your own — those are user / lab gates.

## What this skill does NOT do

- **Direct lab control** (PyLabRobot, Chemspeed, MES). The agent emits proposals; the chemist or batch worker runs them.
- **Multi-tenant cost arbitration.** `cost_cap_usd` is recorded but not enforced — that's owned by the budget-guard hook upstream.
- **Schema migrations.** If a step kind is missing for a workflow you need, file a backlog entry; do not invent new kinds at runtime.
