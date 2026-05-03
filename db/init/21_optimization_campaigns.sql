-- Phase Z5 — closed-loop reaction-optimization campaigns.
--
-- A campaign is one BoFire-driven HTE optimization run: a Domain (factors +
-- objectives + constraints) that gets refined over rounds of proposed +
-- measured experiments. The MCP is stateless; canonical state lives here.
--
-- Tables:
--   optimization_campaigns — one row per campaign; holds the BoFire Domain
--                            JSON (input/output specs) and configuration.
--   optimization_rounds    — one row per proposed batch; holds proposed
--                            conditions and (eventually) measured outcomes.
--
-- The BoFire Strategy is rebuilt from these rows on every request — no
-- opaque blob persistence. Same posture as Z3's yield baseline.
--
-- Re-applicable: IF NOT EXISTS guards everywhere.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- optimization_campaigns
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS optimization_campaigns (
  id                          uuid         PRIMARY KEY DEFAULT uuid_generate_v4(),
  nce_project_id              uuid         NOT NULL REFERENCES nce_projects(id) ON DELETE CASCADE,
  synthetic_step_id           uuid         REFERENCES synthetic_steps(id) ON DELETE SET NULL,
  campaign_name               text         NOT NULL,
  campaign_type               text         NOT NULL DEFAULT 'single_objective'
                                            CHECK (campaign_type IN
                                                   ('single_objective','multi_objective')),
  strategy                    text         NOT NULL DEFAULT 'SoboStrategy'
                                            CHECK (strategy IN
                                                   ('SoboStrategy','MoboStrategy',
                                                    'RandomStrategy','QnehviStrategy')),
  acquisition                 text         NOT NULL DEFAULT 'qLogEI'
                                            CHECK (acquisition IN
                                                   ('qLogEI','qLogNEI','qNEHVI','qEHVI','random')),
  bofire_domain               jsonb        NOT NULL,
  bofire_version              text         NOT NULL DEFAULT '0.3.1',
  status                      text         NOT NULL DEFAULT 'active'
                                            CHECK (status IN
                                                   ('active','paused','completed','aborted')),
  created_by_user_entra_id    text         NOT NULL,
  etag                        bigint       NOT NULL DEFAULT 1,
  created_at                  timestamptz  NOT NULL DEFAULT NOW(),
  updated_at                  timestamptz  NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_optimization_campaigns_updated_at ON optimization_campaigns;
CREATE TRIGGER trg_optimization_campaigns_updated_at
  BEFORE UPDATE ON optimization_campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_opt_campaigns_project
  ON optimization_campaigns(nce_project_id);
CREATE INDEX IF NOT EXISTS idx_opt_campaigns_status
  ON optimization_campaigns(status) WHERE status = 'active';

-- ────────────────────────────────────────────────────────────────────────────
-- optimization_rounds
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS optimization_rounds (
  id                          uuid         PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id                 uuid         NOT NULL REFERENCES optimization_campaigns(id)
                                            ON DELETE CASCADE,
  round_index                 int          NOT NULL,
  proposed_at                 timestamptz  NOT NULL DEFAULT NOW(),
  proposals                   jsonb        NOT NULL,
  measured_outcomes           jsonb,
  ingested_results_at         timestamptz,
  UNIQUE (campaign_id, round_index)
);

CREATE INDEX IF NOT EXISTS idx_opt_rounds_campaign
  ON optimization_rounds(campaign_id, round_index DESC);
CREATE INDEX IF NOT EXISTS idx_opt_rounds_pending
  ON optimization_rounds(campaign_id) WHERE measured_outcomes IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — both tables are project-scoped via nce_project_id chain
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE optimization_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE optimization_campaigns FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS optimization_campaigns_user_access ON optimization_campaigns;
CREATE POLICY optimization_campaigns_user_access ON optimization_campaigns
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM user_project_access upa
     WHERE upa.nce_project_id = optimization_campaigns.nce_project_id
       AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM user_project_access upa
     WHERE upa.nce_project_id = optimization_campaigns.nce_project_id
       AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
  ));

ALTER TABLE optimization_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE optimization_rounds FORCE ROW LEVEL SECURITY;

-- Direct project-membership join (defense-in-depth — does not rely on
-- optimization_campaigns RLS being applied inside the EXISTS subquery,
-- which BYPASSRLS service callers would skip).
DROP POLICY IF EXISTS optimization_rounds_user_access ON optimization_rounds;
CREATE POLICY optimization_rounds_user_access ON optimization_rounds
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM optimization_campaigns c
      JOIN user_project_access upa ON upa.nce_project_id = c.nce_project_id
     WHERE c.id = optimization_rounds.campaign_id
       AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM optimization_campaigns c
      JOIN user_project_access upa ON upa.nce_project_id = c.nce_project_id
     WHERE c.id = optimization_rounds.campaign_id
       AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
  ));

-- ────────────────────────────────────────────────────────────────────────────
-- Grants
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON optimization_campaigns TO chemclaw_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON optimization_rounds TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON optimization_campaigns TO chemclaw_service;
    GRANT ALL ON optimization_rounds TO chemclaw_service;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Z5 model_cards row
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO model_cards (
  service_name, model_version, defined_endpoint, algorithm,
  applicability_domain, predictivity_metrics,
  mechanistic_interpretation, trained_on
) VALUES (
  'mcp_reaction_optimizer', 'reaction_optimizer_v1',
  'Closed-loop Bayesian optimization over a BoFire Domain. Given prior measured outcomes, propose the next batch of conditions to run.',
  'BoFire SoboStrategy with qLogEI acquisition (single-objective). Surrogate is a Gaussian Process with default Matern kernel; categorical inputs handled via one-hot encoding. GP is re-fit from measured_outcomes on every call (no opaque blob persistence).',
  'Reactions whose factor space matches the campaigns Domain. Cold-start (< 3 measured rounds) returns space-filling random batches; warm BO once enough data accumulates.',
  '{"acquisition": "qLogEI", "min_observations_for_bo": 3, "deterministic_seed": true}'::jsonb,
  'No causal model. The GP surrogate is a probabilistic interpolation of measured outcomes; q-LogEI selects the next batch maximizing expected improvement under the surrogate.',
  'Per-campaign: optimization_rounds.measured_outcomes (RLS-scoped to the projects user_project_access).'
)
ON CONFLICT (service_name, model_version) DO NOTHING;

COMMIT;
