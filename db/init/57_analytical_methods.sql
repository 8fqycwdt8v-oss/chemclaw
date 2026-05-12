-- Phase Z6 — canonical analytical-method registry.
--
-- One row per chromatography method (HPLC / UHPLC, RP for v1; HILIC and SFC
-- accommodated by the technique enum for forward-compat). A method is the
-- materialised concrete configuration of a column + eluent + gradient + flow
-- + temperature + detection that produced (or will produce) an injection.
--
-- Methods are project-scoped and RLS-enforced — they sit alongside the
-- optimization_campaigns / optimization_rounds in the closed-loop
-- chromatography-method-development pattern.
--
-- gradient_program is a JSONB list of {time_min, pctB} rows, ordered by
-- time_min. Validation lives in the agent-claw builtin (zod) and the
-- mcp_chrom_method_optimizer materialize step.
--
-- Re-applicable: IF NOT EXISTS guards everywhere.

BEGIN;

CREATE TABLE IF NOT EXISTS analytical_methods (
  id                       uuid         PRIMARY KEY DEFAULT uuid_generate_v4(),
  nce_project_id           uuid         NOT NULL REFERENCES nce_projects(id) ON DELETE CASCADE,
  campaign_id              uuid         REFERENCES optimization_campaigns(id) ON DELETE SET NULL,
  round_id                 uuid         REFERENCES optimization_rounds(id) ON DELETE SET NULL,
  method_name              text         NOT NULL,
  technique                text         NOT NULL DEFAULT 'RP-UHPLC'
                                          CHECK (technique IN
                                                 ('RP-HPLC','RP-UHPLC','HILIC','SFC')),
  column_id                uuid         NOT NULL REFERENCES column_inventory(id),
  b_solvent                text         NOT NULL,
  additive                 text         NOT NULL,
  flow_mLmin               numeric(4,2) NOT NULL,
  T_col_C                  numeric(4,1) NOT NULL,
  detection_mode           text         NOT NULL
                                          CHECK (detection_mode IN
                                                 ('DAD','MS','ELSD','CAD','RID','MS-DAD')),
  gradient_program         jsonb        NOT NULL,
  injection_volume_uL      numeric(4,2),
  total_runtime_min        numeric(5,2),
  is_optimised             boolean      NOT NULL DEFAULT false,
  is_qualified             boolean      NOT NULL DEFAULT false,
  parent_method_id         uuid         REFERENCES analytical_methods(id),
  -- bi-temporal (matches reactions / hypotheses / artifacts pattern from PR-8)
  valid_from               timestamptz  NOT NULL DEFAULT NOW(),
  valid_to                 timestamptz,
  superseded_by            uuid         REFERENCES analytical_methods(id),
  created_by_user_entra_id text         NOT NULL,
  etag                     bigint       NOT NULL DEFAULT 1,
  created_at               timestamptz  NOT NULL DEFAULT NOW(),
  updated_at               timestamptz  NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_analytical_methods_updated_at ON analytical_methods;
CREATE TRIGGER trg_analytical_methods_updated_at
  BEFORE UPDATE ON analytical_methods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_analytical_methods_project
  ON analytical_methods(nce_project_id);
CREATE INDEX IF NOT EXISTS idx_analytical_methods_campaign
  ON analytical_methods(campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_analytical_methods_round
  ON analytical_methods(round_id) WHERE round_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_analytical_methods_optimised
  ON analytical_methods(nce_project_id, is_optimised) WHERE is_optimised = true;

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — same shape as optimization_campaigns (project-scoped via
-- user_project_access). FORCE so the table-owner role does not bypass.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE analytical_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytical_methods FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS analytical_methods_user_access ON analytical_methods;
CREATE POLICY analytical_methods_user_access ON analytical_methods
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM user_project_access upa
     WHERE upa.nce_project_id = analytical_methods.nce_project_id
       AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM user_project_access upa
     WHERE upa.nce_project_id = analytical_methods.nce_project_id
       AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
  ));

-- ────────────────────────────────────────────────────────────────────────────
-- Grants
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON analytical_methods TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON analytical_methods TO chemclaw_service;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Z6 model_cards row
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO model_cards (
  service_name, model_version, defined_endpoint, algorithm,
  applicability_domain, predictivity_metrics,
  mechanistic_interpretation, trained_on
) VALUES (
  'mcp_chrom_method_optimizer', 'chrom_method_optimizer_v1',
  'Closed-loop Bayesian optimization over a BoFire Domain encoding column choice (CategoricalDescriptorInput with Tanaka descriptors), B-solvent, additive, hold-ramp-hold gradient, flow rate, and column temperature. Returns next-batch proposals.',
  'BoFire SoboStrategy with qLogEI (single-objective) or MoboStrategy with qNEHVI (multi-objective). GP surrogate; column categorical encoded by Tanaka 6-axis descriptors so the kernel can interpolate selectivity across columns. Strategy is rebuilt from optimization_rounds.measured_outcomes on every call (no opaque blob persistence).',
  'Reversed-phase HPLC / UHPLC method optimization for small-molecule analytes whose factor space matches the campaigns Domain. Cold-start (< 3 measured rounds) returns space-filling random batches; warm BO once enough data accumulates.',
  '{"acquisition_so": "qLogEI", "acquisition_mo": "qNEHVI", "min_observations_for_bo": 3, "deterministic_seed": true, "gradient_scheme_default": "hold_ramp_hold"}'::jsonb,
  'No causal model. The GP surrogate is a probabilistic interpolation of measured chromatographic-response-function values; q-LogEI / q-NEHVI selects the next batch maximizing expected improvement / hypervolume under the surrogate.',
  'Per-campaign: optimization_rounds.measured_outcomes (RLS-scoped to the projects user_project_access).'
)
ON CONFLICT (service_name, model_version) DO NOTHING;

INSERT INTO schema_version (filename, applied_at)
  VALUES ('57_analytical_methods.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
