# ADR 011 — Synthesis-campaign orchestration

Status: accepted (2026-05-08)

## Context

ChemClaw already ships specialist capabilities for every step of synthesis
planning:

  * **Retrosynthesis** — `propose_retrosynthesis`, ASKCOS, AiZynthFinder,
    `synthegy_retro` skill (strategy-aware reranking).
  * **Condition design** — `recommend_conditions`, `find_similar_reactions`,
    `assess_applicability_domain`, `score_green_chemistry`, the
    `condition-design` and `condition-design-from-literature` skills.
  * **Library synthesis** — `generate_focused_library`, `run_chemspace_screen`,
    the `library_design_planner` skill.
  * **Screening / DoE / HTE** — `design_plate`, the `hte-plate-design` skill,
    BoFire-backed space-filling designs.
  * **BO / closed-loop optimisation** — `optimization_campaigns` +
    `optimization_rounds` tables, `start_optimization_campaign`,
    `recommend_next_batch`, `ingest_campaign_results`, `extract_pareto_front`,
    the `closed-loop-optimization` skill.
  * **Forward prediction & feasibility** — `predict_yield_with_uq`, the
    `pharma-process-readiness` skill, `compute_confidence_ensemble`.
  * **Mechanism, QM, analytics** — `mcp_synthegy_mech`, `mcp_xtb`,
    `mcp_chemprop`, `mcp_sirius`, the `qm_pipeline_planner` skill.
  * **Lab data** — `mcp_eln_local` (port 8013) + `mcp_logs_sciy` (port 8016)
    with five ELN builtins and four LOGS builtins.

What is **missing** is the umbrella that ties them together for an autonomous,
multi-day workflow:

  1. **No autonomous orchestrator entity.** Slash verbs activate one skill at
     a time; no agent self-routing for "synthesize molecule X" → retro →
     condition-design → HTE → readiness gate without user micromanagement.
  2. **No persistent multi-round campaign state.** `optimization_campaigns`
     and `chemspace_screens` are leaves; nothing links them to a higher-level
     goal, a session, or a multi-step plan. Synthesis state lives only in
     `agent_sessions.scratchpad` and dies on session restart.
  3. **No die-gate / readiness gate engine.** "BO-or-die" (abort after N
     rounds with no improvement, or once a budget cap is hit) is not a
     first-class concept — chemists today either remember to abort or burn
     the budget.
  4. **No synthesis-planning prompt mode.** `agent.system` is general; there
     is no system prompt that biases the model toward the campaign-state
     contract.
  5. **No DAG of synthesis steps.** Retrosynthesis routes, condition
     candidates, BO rounds, and ELN entries each live in their own table;
     none of them encode dependencies of the form "this BO round waits on
     ingest of round N-1".

## Decision

Introduce a `synthesis_campaigns` umbrella table plus a `synthesis_campaign_steps`
DAG and a `synthesis_campaign_events` audit log, and expose seven builtins
that let the agent drive them autonomously. Wire up a new slash verb
`/synthesize`, a new prompt-registry mode `agent.synthesis_planner`, and a
new skill `synthesis_campaign_orchestrator` that knows the per-kind playbook.

### Data model (db/init/51_synthesis_campaigns.sql)

```
synthesis_campaigns
  ├─ id (uuid, PK)
  ├─ nce_project_id  → nce_projects.id   (RLS chain)
  ├─ agent_session_id → agent_sessions.id (resumability)
  ├─ kind ∈ { single_experiment, library_synthesis,
  │            screening, bo_campaign, bo_or_die }
  ├─ goal jsonb   — per-kind structured intent
  ├─ policy jsonb — auto_advance, readiness_floor, budget_max_experiments,
  │                 die_after_no_improvement_rounds, bo_acquisition,
  │                 max_concurrent_steps, abort_on_die, cost_cap_usd
  ├─ status ∈ { proposed, active, awaiting_measurement, paused,
  │             completed, aborted, failed, died }
  ├─ etag, valid_from, valid_to (bi-temporal)
  └─ trigger emit_synthesis_campaign_event → ingestion_events
       (synthesis_campaign_created | synthesis_campaign_state_changed)

synthesis_campaign_steps
  ├─ id, campaign_id, step_index UNIQUE
  ├─ kind ∈ { retrosynthesis, literature_pull, condition_design,
  │           library_design, hte_plate_design, bo_round,
  │           forward_prediction, qm_screen, mechanism_check,
  │           feasibility_assessment, submit_batch, measurement_wait,
  │           ingest_results, readiness_gate, die_check, summary }
  ├─ status ∈ { pending, in_progress, completed, skipped, failed, cancelled }
  ├─ inputs jsonb, outputs jsonb, notes text
  ├─ depends_on uuid[]   — DAG edges
  └─ ref_table + ref_id  — pointer at the leaf artifact:
       optimization_campaigns | optimization_rounds |
       chemspace_screens | chemspace_results |
       mock_eln.entries | mock_eln.samples |
       workflow_runs | genchem_runs | task_batches |
       qm_results | reactions

synthesis_campaign_events
  ├─ id, campaign_id, step_id?, event_type, payload, occurred_at
  └─ event_type ∈ { campaign_created, campaign_status_changed,
                    step_added, step_started, step_completed, step_skipped,
                    step_cancelled, step_failed,
                    gate_passed, gate_failed, die_triggered,
                    measurement_recorded, campaign_completed,
                    campaign_aborted }
```

RLS is project-scoped via `nce_project_id → user_project_access`, identical
to `optimization_campaigns` and `chemspace_screens`. Steps and events
inherit the campaign's project via JOIN. `chemclaw_app` gets
`SELECT/INSERT/UPDATE/DELETE`; `chemclaw_service` (BYPASSRLS) gets ALL.

### Builtins (services/agent-claw/src/tools/builtins/)

| Tool | Read-only? | Purpose |
|---|---|---|
| `start_synthesis_campaign` | no | Insert the umbrella row, optionally seed the per-kind playbook. |
| `list_synthesis_campaigns` | yes | Find resumable campaigns; first call on every turn. |
| `get_synthesis_campaign` | yes | Hydrate a campaign + steps + recent events. |
| `add_synthesis_campaign_step` | no | Append a step (e.g. an extra `bo_round` after a `readiness_gate` shortfall). |
| `update_synthesis_campaign_step` | no | Transition a step's status; attach outputs and `ref_table`/`ref_id`. |
| `advance_synthesis_campaign` | no | **Next-step oracle.** Walks the DAG, claims the next ready step, evaluates BO-or-die guards, flips terminal states. |
| `record_synthesis_campaign_outcome` | no | Close the campaign with a terminal status + outcome_summary. |

### Per-kind playbook (skills/synthesis_campaign_orchestrator/SKILL.md)

| kind | Default step sequence |
|---|---|
| `single_experiment` | retrosynthesis → literature_pull → condition_design → feasibility_assessment → forward_prediction → readiness_gate → summary |
| `library_synthesis` | library_design → feasibility_assessment → hte_plate_design → submit_batch → measurement_wait → ingest_results → summary |
| `screening` | condition_design → hte_plate_design → submit_batch → measurement_wait → ingest_results → summary |
| `bo_campaign` | condition_design → bo_round → submit_batch → measurement_wait → ingest_results → readiness_gate → summary |
| `bo_or_die` | condition_design → bo_round → submit_batch → measurement_wait → ingest_results → die_check → readiness_gate → summary |

Each step kind has a `STEP_KIND_TO_TOOL_HINT` mapping in
`_synthesis_shared.ts` that `advance_synthesis_campaign` returns to the
orchestrator skill, removing the LLM's burden of re-deriving "what tool now?"
on every turn.

### Die-gate semantics (`bo_or_die`)

`advance_synthesis_campaign` aggregates rolling counters from prior steps
within the same campaign:

  * `rounds_run`     = COUNT(steps WHERE kind='bo_round' AND status='completed')
  * `rounds_with_improvement` = SUM(steps WHERE kind='bo_round' AND outputs.improved=true)
  * `experiments_used` = SUM(steps WHERE kind='ingest_results' AND outputs.experiments_added > 0)

A die fires (status → `died`, event → `die_triggered`) when either:

  * `rounds_run - rounds_with_improvement >= policy.die_after_no_improvement_rounds`
  * `experiments_used >= policy.budget_max_experiments`

The orchestrator skill writes `outputs.improved=true` on the latest
`bo_round` step iff the best objective improved over the prior round's best.

### State machine (campaign lifecycle)

```
proposed
  │
  │ first advance_synthesis_campaign claim
  ▼
active ──────────► awaiting_measurement ──┐
  │                  │ (measurement arrives)│
  │  pause           │                       │
  ▼                  ▼                       │
paused           active ◄──────────────────┘
  │                  │
  │                  │ all steps terminal             OR die_check fires       OR explicit user abort
  │                  ▼                                ▼                         ▼
  └──────────────► completed                         died                     aborted
                     │                                                          │
                     ▼                                                          ▼
                                            (terminal: no further changes)
```

`failed` is a terminal alternative reached when an unrecoverable step
failure is escalated by `record_synthesis_campaign_outcome`.

### Orchestrator skill

A new skill `synthesis_campaign_orchestrator` (skills/synthesis_campaign_orchestrator/SKILL.md)
holds the playbook prose. It is activated by the `/synthesize` slash verb
(via `VERB_TO_SKILL[synthesize] = "synthesis_campaign_orchestrator"`), and
its first move on any turn is `list_synthesis_campaigns` — the agent
*always* checks for resumable state before starting fresh.

### Integration with existing artifacts

The DAG steps point outward via `ref_table` + `ref_id`:

  * `bo_round` → `optimization_campaigns` (creation) and `optimization_rounds` (per round)
  * `library_design` → `genchem_runs`
  * `hte_plate_design` → existing plate-design output (free-form `outputs.plate` until a dedicated plates table is added)
  * `submit_batch` → `task_batches`
  * `qm_screen` → `qm_results`
  * `ingest_results` → `mock_eln.entries` (or canonical `experiments` once that flow is live)

This means the campaign carries both the agent's planning intent (in
`synthesis_campaign_steps.outputs`) and the canonical scientific state (in
the leaf tables), without duplicating either.

## Consequences

**Positive**

  * One concept the user can reference: "campaign:abc123" — instead of
    five distinct UUIDs (round, screen, ELN, batch, …).
  * Resumable autonomous workflows. Session restarts don't lose state.
  * "BO-or-die" is enforceable and auditable, not chemist-judgement.
  * The orchestrator's next-step decision moves from LLM prose to
    deterministic SQL — cheaper, faster, and provably consistent.
  * KG projector pipeline can subscribe to `synthesis_campaign_*` events
    immediately (vocabulary catalog entries land in the same migration).

**Negative**

  * One more table family to migrate / back up. Tracked in
    `db/init/51_synthesis_campaigns.sql`.
  * Step kinds are an enum in a CHECK constraint; new kinds need a code
    change + migration. Acceptable: the alternative (free-form text) loses
    the playbook contract.
  * The orchestrator's step-kind-to-tool mapping is documentation-driven —
    the LLM can still make a mistake even after `advance_synthesis_campaign`
    returns the hint. Tracked in BACKLOG: turn the hint into a hard
    permission filter via the permission resolver hook.

**Deferred**

  * **No KG projector for synthesis_campaign_*** events yet — the catalog
    entries are in place so a `kg_synthesis_campaigns` projector can be
    added in a follow-up without another migration.
  * **No campaign-level cost-cap enforcement.** `policy.cost_cap_usd` is
    recorded but only consulted by the orchestrator skill prose. A budget
    hook tying it to `tool_costs_usd` is a follow-up.
  * **No campaign-level shadow / canary mode.** All campaigns run live;
    shadow execution against a held-out campaign log is a follow-up.
  * **No direct lab automation.** Hardware integration (PyLabRobot,
    Chemspeed) remains out of scope: the agent emits proposals.

## References

  * `db/init/21_optimization_campaigns.sql` (BO leaf table)
  * `db/init/28_screens.sql` (chemspace_screens leaf table)
  * `db/init/30_mock_eln_schema.sql` + `db/init/31_fake_logs_schema.sql`
  * `services/agent-claw/src/tools/builtins/_synthesis_shared.ts`
    (PLAYBOOK + STEP_KIND_TO_TOOL_HINT + Zod schemas)
  * `skills/closed-loop-optimization/SKILL.md` and other specialist skills
    that the orchestrator dispatches to.
  * `docs/runbooks/synthesis-campaign-lifecycle.md` (operator runbook).
