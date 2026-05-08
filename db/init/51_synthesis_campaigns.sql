-- Synthesis campaigns — autonomous orchestration of synthesis-planning
-- workflows. One umbrella entity for any of:
--   * single_experiment   — one molecule synthesis (retro → conditions → run)
--   * library_synthesis   — focused-library design + parallel synthesis
--   * screening           — HTE screening of a condition space
--   * bo_campaign         — Bayesian-optimization closed-loop reaction dev
--   * bo_or_die           — BO with hard budget + die-after-no-improvement gate
--
-- Why this layer exists:
--   * `optimization_campaigns` (db/init/21) and `chemspace_screens` (28) are
--     LEAF artifacts. They hold the state of one BO run or one screen, but
--     nothing links them to a higher-level goal, a multi-step plan, or the
--     agent_session that's driving them.
--   * Without this table, multi-day synthesis plans live only in the agent's
--     context window — a session restart loses the entire campaign state.
--   * Synthesis_campaign_steps form a DAG (depends_on UUID[]) that captures
--     "first retro, then condition-design for the top route, then screen, then
--     readiness gate, then HTE plate". Each step's `ref_table` + `ref_id` link
--     out to the existing leaf artifacts (one bo_round step → one
--     optimization_rounds row, one library_design step → one genchem_runs row,
--     one submit_batch step → one task_batches row, etc.).
--   * Bi-temporal columns + ingestion_events emission keep the KG projector
--     pipeline in sync.
--
-- RLS: project-scoped via nce_project_id → user_project_access (same pattern
--      as optimization_campaigns and chemspace_screens).

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- synthesis_campaigns — the umbrella
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS synthesis_campaigns (
  id                          uuid         PRIMARY KEY DEFAULT uuid_generate_v4(),
  nce_project_id              uuid         NOT NULL REFERENCES nce_projects(id) ON DELETE CASCADE,
  synthetic_step_id           uuid         REFERENCES synthetic_steps(id) ON DELETE SET NULL,
  agent_session_id            uuid         REFERENCES agent_sessions(id) ON DELETE SET NULL,

  kind                        text         NOT NULL
                                            CHECK (kind IN (
                                              'single_experiment',
                                              'library_synthesis',
                                              'screening',
                                              'bo_campaign',
                                              'bo_or_die'
                                            )),
  name                        text         NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),

  -- Free-form goal (per kind):
  --   single_experiment:  { target_smiles, target_inchikey?, max_steps?, max_routes? }
  --   library_synthesis:  { scaffold_smiles?, scaffold_smarts?, library_size, design_strategy }
  --   screening:          { reaction_smiles, factor_space, plate_format }
  --   bo_campaign:        { reaction_smiles, objectives, factors, max_rounds, target_yield_pct? }
  --   bo_or_die:          bo_campaign + { budget_max_experiments, die_after_no_improvement_rounds }
  goal                        jsonb        NOT NULL DEFAULT '{}'::jsonb,

  -- Policy controls (consulted by advance_synthesis_campaign):
  --   { auto_advance: bool, readiness_floor: 'exploratory'|'pilot'|'scale',
  --     max_concurrent_steps: int, bo_acquisition: 'qLogEI'|...,
  --     cost_cap_usd: number, abort_on_die: bool, require_user_approval: bool }
  policy                      jsonb        NOT NULL DEFAULT '{}'::jsonb,

  status                      text         NOT NULL DEFAULT 'proposed'
                                            CHECK (status IN (
                                              'proposed',
                                              'active',
                                              'awaiting_measurement',
                                              'paused',
                                              'completed',
                                              'aborted',
                                              'failed',
                                              'died'
                                            )),

  outcome_summary             text,        -- terse human-readable summary at completion
  total_steps                 int          NOT NULL DEFAULT 0 CHECK (total_steps >= 0),
  completed_steps             int          NOT NULL DEFAULT 0 CHECK (completed_steps >= 0),

  created_by_user_entra_id    text         NOT NULL,
  etag                        bigint       NOT NULL DEFAULT 1 CHECK (etag > 0),
  created_at                  timestamptz  NOT NULL DEFAULT NOW(),
  updated_at                  timestamptz  NOT NULL DEFAULT NOW(),

  -- Bi-temporal (consistent with reactions, hypotheses, artifacts).
  valid_from                  timestamptz  NOT NULL DEFAULT NOW(),
  valid_to                    timestamptz                          -- null ⇒ current
);

CREATE INDEX IF NOT EXISTS idx_synth_camp_project_status
  ON synthesis_campaigns (nce_project_id, status);
CREATE INDEX IF NOT EXISTS idx_synth_camp_user_active
  ON synthesis_campaigns (created_by_user_entra_id, updated_at DESC)
  WHERE status IN ('proposed', 'active', 'awaiting_measurement', 'paused');
CREATE INDEX IF NOT EXISTS idx_synth_camp_session
  ON synthesis_campaigns (agent_session_id) WHERE agent_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_synth_camp_kind_status
  ON synthesis_campaigns (kind, status);

DROP TRIGGER IF EXISTS trg_synthesis_campaigns_updated_at ON synthesis_campaigns;
CREATE TRIGGER trg_synthesis_campaigns_updated_at
  BEFORE UPDATE ON synthesis_campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ────────────────────────────────────────────────────────────────────────────
-- synthesis_campaign_steps — the DAG nodes
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS synthesis_campaign_steps (
  id                          uuid         PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id                 uuid         NOT NULL REFERENCES synthesis_campaigns(id) ON DELETE CASCADE,
  step_index                  int          NOT NULL CHECK (step_index >= 0),

  kind                        text         NOT NULL
                                            CHECK (kind IN (
                                              'retrosynthesis',
                                              'literature_pull',
                                              'condition_design',
                                              'library_design',
                                              'hte_plate_design',
                                              'bo_round',
                                              'forward_prediction',
                                              'qm_screen',
                                              'mechanism_check',
                                              'feasibility_assessment',
                                              'submit_batch',
                                              'measurement_wait',
                                              'ingest_results',
                                              'readiness_gate',
                                              'die_check',
                                              'summary'
                                            )),

  status                      text         NOT NULL DEFAULT 'pending'
                                            CHECK (status IN (
                                              'pending',
                                              'in_progress',
                                              'completed',
                                              'skipped',
                                              'failed',
                                              'cancelled'
                                            )),

  -- Inputs given to the agent when the step runs (e.g. SMILES, factor list).
  -- Outputs produced by the step (e.g. retro_routes[], conditions[], yields).
  inputs                      jsonb        NOT NULL DEFAULT '{}'::jsonb,
  outputs                     jsonb        NOT NULL DEFAULT '{}'::jsonb,
  notes                       text,

  -- Pointer into existing system tables; lets us trace one step back to
  -- the leaf artifact it produced (BO round, screen, ELN entry, batch job).
  --   ref_table ∈ {
  --     'optimization_campaigns', 'optimization_rounds',
  --     'chemspace_screens', 'chemspace_results',
  --     'mock_eln.entries', 'mock_eln.samples',
  --     'workflow_runs', 'genchem_runs', 'task_batches',
  --     'qm_results', 'reactions'
  --   }
  ref_table                   text,
  ref_id                      text,

  -- DAG dependencies: this step waits on these steps to reach `completed`.
  depends_on                  uuid[]       NOT NULL DEFAULT ARRAY[]::uuid[],

  started_at                  timestamptz,
  completed_at                timestamptz,
  created_at                  timestamptz  NOT NULL DEFAULT NOW(),
  updated_at                  timestamptz  NOT NULL DEFAULT NOW(),

  CONSTRAINT synth_step_unique_index UNIQUE (campaign_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_synth_step_campaign
  ON synthesis_campaign_steps (campaign_id, step_index);
CREATE INDEX IF NOT EXISTS idx_synth_step_status
  ON synthesis_campaign_steps (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_synth_step_ref
  ON synthesis_campaign_steps (ref_table, ref_id) WHERE ref_table IS NOT NULL;

DROP TRIGGER IF EXISTS trg_synthesis_campaign_steps_updated_at ON synthesis_campaign_steps;
CREATE TRIGGER trg_synthesis_campaign_steps_updated_at
  BEFORE UPDATE ON synthesis_campaign_steps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ────────────────────────────────────────────────────────────────────────────
-- synthesis_campaign_events — append-only audit
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS synthesis_campaign_events (
  id              uuid         PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id     uuid         NOT NULL REFERENCES synthesis_campaigns(id) ON DELETE CASCADE,
  step_id         uuid         REFERENCES synthesis_campaign_steps(id) ON DELETE SET NULL,
  event_type      text         NOT NULL
                                CHECK (event_type IN (
                                  'campaign_created',
                                  'campaign_status_changed',
                                  'step_added',
                                  'step_started',
                                  'step_completed',
                                  'step_failed',
                                  'gate_passed',
                                  'gate_failed',
                                  'die_triggered',
                                  'measurement_recorded',
                                  'campaign_completed',
                                  'campaign_aborted'
                                )),
  payload         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_synth_event_campaign_time
  ON synthesis_campaign_events (campaign_id, occurred_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- Trigger: emit ingestion_events on campaign INSERT and on status change
-- (so KG projectors can consume `synthesis_campaign_*` events).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION emit_synthesis_campaign_event()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
    VALUES (
      'synthesis_campaign_created',
      'synthesis_campaigns',
      NEW.id,
      jsonb_build_object(
        'campaign_id', NEW.id::text,
        'kind', NEW.kind,
        'name', NEW.name,
        'nce_project_id', NEW.nce_project_id::text,
        'created_by_user_entra_id', NEW.created_by_user_entra_id
      )
    );
  ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
    VALUES (
      'synthesis_campaign_state_changed',
      'synthesis_campaigns',
      NEW.id,
      jsonb_build_object(
        'campaign_id', NEW.id::text,
        'kind', NEW.kind,
        'old_status', OLD.status,
        'new_status', NEW.status,
        'nce_project_id', NEW.nce_project_id::text
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_synthesis_campaign_event ON synthesis_campaigns;
CREATE TRIGGER trg_synthesis_campaign_event
  AFTER INSERT OR UPDATE OF status ON synthesis_campaigns
  FOR EACH ROW EXECUTE FUNCTION emit_synthesis_campaign_event();

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — project-scoped via nce_project_id → user_project_access
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE synthesis_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE synthesis_campaigns FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS synthesis_campaigns_user_access ON synthesis_campaigns;
CREATE POLICY synthesis_campaigns_user_access ON synthesis_campaigns
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM user_project_access upa
     WHERE upa.nce_project_id = synthesis_campaigns.nce_project_id
       AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM user_project_access upa
     WHERE upa.nce_project_id = synthesis_campaigns.nce_project_id
       AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
  ));

ALTER TABLE synthesis_campaign_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE synthesis_campaign_steps FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS synthesis_campaign_steps_user_access ON synthesis_campaign_steps;
CREATE POLICY synthesis_campaign_steps_user_access ON synthesis_campaign_steps
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM synthesis_campaigns sc
      JOIN user_project_access upa ON upa.nce_project_id = sc.nce_project_id
     WHERE sc.id = synthesis_campaign_steps.campaign_id
       AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM synthesis_campaigns sc
      JOIN user_project_access upa ON upa.nce_project_id = sc.nce_project_id
     WHERE sc.id = synthesis_campaign_steps.campaign_id
       AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
  ));

ALTER TABLE synthesis_campaign_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE synthesis_campaign_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS synthesis_campaign_events_user_access ON synthesis_campaign_events;
CREATE POLICY synthesis_campaign_events_user_access ON synthesis_campaign_events
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM synthesis_campaigns sc
      JOIN user_project_access upa ON upa.nce_project_id = sc.nce_project_id
     WHERE sc.id = synthesis_campaign_events.campaign_id
       AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM synthesis_campaigns sc
      JOIN user_project_access upa ON upa.nce_project_id = sc.nce_project_id
     WHERE sc.id = synthesis_campaign_events.campaign_id
       AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
  ));

-- ────────────────────────────────────────────────────────────────────────────
-- Grants
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON synthesis_campaigns       TO chemclaw_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON synthesis_campaign_steps  TO chemclaw_app;
    GRANT SELECT, INSERT                  ON synthesis_campaign_events TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON synthesis_campaigns       TO chemclaw_service;
    GRANT ALL ON synthesis_campaign_steps  TO chemclaw_service;
    GRANT ALL ON synthesis_campaign_events TO chemclaw_service;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Event-vocabulary catalog entries
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO ingestion_event_catalog (event_type, description, emitted_by, consumed_by) VALUES
  ('synthesis_campaign_created',
   'A new synthesis_campaigns row was inserted by start_synthesis_campaign.',
   'db/init/51_synthesis_campaigns.sql (trigger trg_synthesis_campaign_event)',
   ARRAY[]::TEXT[]),
  ('synthesis_campaign_state_changed',
   'A synthesis_campaigns.status transitioned (proposed → active → completed/aborted/died/etc.). Emitted defensively on status UPDATE.',
   'db/init/51_synthesis_campaigns.sql (trigger trg_synthesis_campaign_event)',
   ARRAY[]::TEXT[])
ON CONFLICT (event_type) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- schema_version
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO schema_version (filename, applied_at)
  VALUES ('51_synthesis_campaigns.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
