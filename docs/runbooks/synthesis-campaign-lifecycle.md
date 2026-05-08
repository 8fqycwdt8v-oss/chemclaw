# Runbook — synthesis-campaign lifecycle

How to start, observe, pause, resume, and abort autonomous synthesis
campaigns driven by the `/synthesize` slash verb.

See ADR 011 (`docs/adr/011-synthesis-campaign-orchestration.md`) for the
design rationale, state machine, and integration map.

## Start a campaign

```
/synthesize Synthesise (S)-N-Boc-piperidine-3-carboxylic acid for project NCE-0042; pilot-grade.
```

The agent will:

  1. Call `list_synthesis_campaigns({status: ['proposed','active','awaiting_measurement','paused'], only_mine: true})` to look for an in-flight campaign on the same target.
  2. If none, classify the intent (here `single_experiment`), then call `start_synthesis_campaign({nce_project_internal_id, kind, name, goal, policy, seed_playbook: true})`. The playbook seeds the canonical step list for the kind.
  3. Walk the DAG by repeatedly calling `advance_synthesis_campaign` until it hits `awaiting_measurement` (yields to the user) or `campaign_completed`.

Inspect a campaign at any time:

```sql
SELECT id, kind, status, completed_steps || '/' || total_steps AS progress,
       created_at, updated_at
  FROM synthesis_campaigns
 WHERE created_by_user_entra_id = :user_entra_id
 ORDER BY updated_at DESC
 LIMIT 10;
```

The full DAG (with leaf-artifact links):

```sql
SELECT step_index, kind, status, ref_table, ref_id,
       jsonb_pretty(outputs) AS outputs
  FROM synthesis_campaign_steps
 WHERE campaign_id = :campaign_id
 ORDER BY step_index;
```

## Pause / resume

The agent never auto-pauses; pausing is admin-driven (e.g. for a chemistry
freeze):

```sql
-- Pause
UPDATE synthesis_campaigns SET status = 'paused', etag = etag + 1
 WHERE id = :campaign_id AND status IN ('proposed','active','awaiting_measurement');

-- Resume
UPDATE synthesis_campaigns SET status = 'active', etag = etag + 1
 WHERE id = :campaign_id AND status = 'paused';
```

The `synthesis_campaign_state_changed` event fires automatically; KG
projectors that subscribe pick it up.

The agent re-discovers a paused campaign on its next `/synthesize` invocation
because `list_synthesis_campaigns` includes `paused` by default.

## Abort

```sql
UPDATE synthesis_campaigns
   SET status = 'aborted', outcome_summary = '<reason>', etag = etag + 1
 WHERE id = :campaign_id;
```

Or, in chat:

```
@agent Please abort campaign abc123 — superseded by NCE-0099.
```

The agent will call `record_synthesis_campaign_outcome({status: 'aborted', outcome_summary})`.

## Die-gate handling (`bo_or_die` only)

`advance_synthesis_campaign` evaluates the policy gates on every call. A die
fires when either:

  * `rounds_run - rounds_with_improvement ≥ policy.die_after_no_improvement_rounds`
  * `experiments_used ≥ policy.budget_max_experiments`

Verify a die was triggered:

```sql
SELECT occurred_at, payload
  FROM synthesis_campaign_events
 WHERE campaign_id = :campaign_id AND event_type = 'die_triggered';
```

The campaign moves to `died` (not `completed`); the orchestrator skill is
required to surface the rationale to the user.

## Linking a step to a leaf artifact

Whenever a step kind has a corresponding canonical row, the orchestrator
must populate `ref_table` + `ref_id` via `update_synthesis_campaign_step`:

| step kind | ref_table | ref_id |
|---|---|---|
| `bo_round` (round 1) | `optimization_campaigns` | `<uuid>` |
| `bo_round` (round 2+) | `optimization_rounds` | `<uuid>` |
| `library_design` | `genchem_runs` | `<uuid>` |
| `submit_batch` | `task_batches` | `<uuid>` |
| `qm_screen` | `qm_results` | `<uuid>` (one per descriptor batch) |
| `ingest_results` | `mock_eln.entries` | `<entry_id>` (per OFAT row) |

This populates `idx_synth_step_ref` and lets analysts answer "which campaign
produced this BO round?" without grepping JSON.

## Replaying state to the KG

The migration adds two ingestion-event vocabulary entries:

  * `synthesis_campaign_created`
  * `synthesis_campaign_state_changed`

A future `kg_synthesis_campaigns` projector can subscribe to them. To
backfill the KG once that projector lands, `DELETE FROM projection_acks WHERE
projector_name='kg_synthesis_campaigns'` and restart the projector — the
existing `ingestion_events` rows replay deterministically.

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `synthesis_campaign_not_found_or_forbidden` | RLS gate. User has no access to the project. | Add a `user_project_access` row, or impersonate the right user. |
| Campaign stuck in `awaiting_measurement` | The chemist hasn't reported results. | The agent calls `ask_user`; the user replies with the measurement, the agent marks the step `completed` and re-advances. |
| Campaign stuck in `active` with `no_ready_steps` | A `pending` step's `depends_on` references a step that never completed. | Mark the upstream step `skipped` (manually via `update_synthesis_campaign_step`) if it's truly not needed; otherwise complete it. |
| Die fired prematurely | Misconfigured policy. | `record_synthesis_campaign_outcome({status: 'aborted', outcome_summary: 'policy revision'})` and start a new campaign with the corrected `die_after_no_improvement_rounds`. |
| BO improvement detection false-negative | Orchestrator forgot to set `outputs.improved=true` on a successful `bo_round`. | Update the step row directly, then re-run `advance_synthesis_campaign`. |

## Telemetry

  * Every campaign emits `campaign_created`, `campaign_status_changed`,
    `step_added`, `step_started`, `step_completed`, `step_failed`,
    `die_triggered`, `gate_passed`, `gate_failed`, `measurement_recorded`,
    `campaign_completed`, `campaign_aborted` events into
    `synthesis_campaign_events`.
  * The trigger on `synthesis_campaigns` mirrors created/state-changed events
    into `ingestion_events` so KG projectors see them.
  * Step-by-step token / cost telemetry is owned by the budget-guard hook in
    the harness, not by the campaign tables.
