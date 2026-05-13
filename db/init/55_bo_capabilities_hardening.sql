-- BO capabilities hardening (review-bot-capabilities branch).
--
-- Closes the gaps surfaced by the deep review of the closed-loop BO surface:
--   • Per-campaign RNG seed so cold-start runs of the same Domain don't all
--     return the identical plate.
--   • FK from optimization_campaigns → synthesis_campaigns so the umbrella
--     orchestrator can ask "which campaign owns this BO run?" without
--     scanning synthesis_campaign_steps for ref_table='optimization_*'.
--   • Live BoFire version recorded at INSERT time instead of the static
--     '0.3.1' default lying about whatever the running container has.
--   • ingestion_events emission on optimization_rounds INSERT and on
--     measured_outcomes ingest, so the KG / vector projector pipeline sees
--     BO data (the A-on-C event-sourced posture from CLAUDE.md).
--   • Event-vocabulary catalog rows for the two new event types.
--   • prompt_registry seed for the agent.bo_planner mode used by the
--     closed-loop-optimization skill.
--
-- The old hardcoded `bofire_version` default of '0.3.1' is dropped so future
-- inserts must populate it explicitly (start_optimization_campaign reads
-- the live version from /build_domain).
--
-- Re-applicable: IF NOT EXISTS / OR REPLACE / DROP IF EXISTS guards
-- throughout. New columns are nullable so the migration works on populated
-- tables.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- optimization_campaigns: new columns
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE optimization_campaigns
  ADD COLUMN IF NOT EXISTS seed                  bigint,
  ADD COLUMN IF NOT EXISTS synthesis_campaign_id uuid REFERENCES synthesis_campaigns(id)
                                                  ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS constraints           jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS output_bounds         jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_opt_campaigns_synth
  ON optimization_campaigns(synthesis_campaign_id)
  WHERE synthesis_campaign_id IS NOT NULL;

-- Drop the static default; future inserts must pass the live BoFire version.
ALTER TABLE optimization_campaigns
  ALTER COLUMN bofire_version DROP DEFAULT;

-- ────────────────────────────────────────────────────────────────────────────
-- optimization_rounds → ingestion_events trigger
--
-- Two event types:
--   * optimization_round_proposed   — INSERT (round_index + n_proposals)
--   * optimization_results_ingested — UPDATE that flips ingested_results_at
--
-- Payloads carry only ids and counts; the actual proposals / outcomes stay in
-- their JSONB columns to keep the event log small and replay-cheap.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION emit_optimization_round_event()
RETURNS TRIGGER AS $$
DECLARE
  v_project_id uuid;
BEGIN
  SELECT nce_project_id INTO v_project_id
    FROM optimization_campaigns WHERE id = NEW.campaign_id;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
    VALUES (
      'optimization_round_proposed',
      'optimization_rounds',
      NEW.id,
      jsonb_build_object(
        'campaign_id',     NEW.campaign_id::text,
        'round_id',        NEW.id::text,
        'round_index',     NEW.round_index,
        'n_proposals',     COALESCE(jsonb_array_length(NEW.proposals), 0),
        'nce_project_id',  v_project_id::text
      )
    );
  ELSIF TG_OP = 'UPDATE'
        AND OLD.ingested_results_at IS NULL
        AND NEW.ingested_results_at IS NOT NULL THEN
    INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
    VALUES (
      'optimization_results_ingested',
      'optimization_rounds',
      NEW.id,
      jsonb_build_object(
        'campaign_id',     NEW.campaign_id::text,
        'round_id',        NEW.id::text,
        'round_index',     NEW.round_index,
        'n_outcomes',      COALESCE(jsonb_array_length(NEW.measured_outcomes), 0),
        'nce_project_id',  v_project_id::text
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_optimization_round_event ON optimization_rounds;
CREATE TRIGGER trg_optimization_round_event
  AFTER INSERT OR UPDATE OF measured_outcomes, ingested_results_at ON optimization_rounds
  FOR EACH ROW EXECUTE FUNCTION emit_optimization_round_event();

-- ────────────────────────────────────────────────────────────────────────────
-- Event-vocabulary catalog entries
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO ingestion_event_catalog (event_type, description, emitted_by, consumed_by) VALUES
  ('optimization_round_proposed',
   'A new optimization_rounds row was inserted by recommend_next_batch (proposals only; measured_outcomes still NULL).',
   'db/init/55_bo_capabilities_hardening.sql (trigger trg_optimization_round_event)',
   ARRAY[]::TEXT[]),
  ('optimization_results_ingested',
   'optimization_rounds.measured_outcomes was populated by ingest_campaign_results.',
   'db/init/55_bo_capabilities_hardening.sql (trigger trg_optimization_round_event)',
   ARRAY[]::TEXT[])
ON CONFLICT (event_type) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- prompt_registry seed for agent.bo_planner
--
-- Active = true so the agent can fetch the active version directly. metadata
-- carries description + provenance for the audit trail expected by review.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO prompt_registry (
  prompt_name, version, template, metadata, created_by, approved_by, approved_at, active
) VALUES (
  'agent.bo_planner',
  1,
  $TPL$
You are a closed-loop optimization planner for ChemClaw.

When working on an optimization_campaigns row your job is:

1. Decide n_candidates per round based on the lab's plate format (24, 48, 96)
   and the chemist's measurement budget. Default to 8 unless told otherwise.
2. Read the `source` field on every proposal returned by recommend_next_batch.
   Values starting with `random_*_failed` mean BoFire crashed and the loop
   degraded silently; investigate before continuing.
3. After every ingest_campaign_results, compare the round's best output to
   the running best from prior rounds. Record `improved: true|false` and
   `experiments_added: <int>` on the parent synthesis_campaign_steps row via
   update_synthesis_campaign_step — these are the signals the bo_or_die
   gate consumes.
4. For bo_or_die campaigns, treat `die_after_no_improvement_rounds` and
   `budget_max_experiments` as hard gates. Do not argue with the gate; let
   advance_synthesis_campaign trigger 'died' if the policy says so.
5. Cite measurements, not surrogate predictions, in summaries.
$TPL$,
  jsonb_build_object(
    'description', 'Closed-loop BO planner mode used by skills/closed-loop-optimization.',
    'reviewed_in', '55_bo_capabilities_hardening.sql'
  ),
  '__system__',
  '__system__',
  NOW(),
  TRUE
)
ON CONFLICT (prompt_name, version) DO NOTHING;

INSERT INTO schema_version (filename, applied_at)
  VALUES ('55_bo_capabilities_hardening.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
