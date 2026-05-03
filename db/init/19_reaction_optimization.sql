-- Phase Z0 of the reaction-condition-prediction & optimization stack.
--
-- Adds the `model_cards` table — one row per registered ML model that ships
-- predictions through ChemClaw's confidence-tier propagation. Each row
-- captures the OECD QSAR validation principles (defined endpoint, unambiguous
-- algorithm, defined applicability domain, predictivity statistics,
-- mechanistic interpretation) so any prediction can be audited back to the
-- model that produced it.
--
-- Z0 seeds one row for the ASKCOS condition recommender. Later phases
-- (Z1 applicability domain, Z3 yield baseline, Z5 BoFire optimizer) will
-- INSERT additional rows — `service_name + model_version` is the natural key.
--
-- Re-applicable: IF NOT EXISTS guards everywhere; the seed INSERT uses
-- ON CONFLICT DO NOTHING so re-applying the migration on a populated DB is
-- a no-op.

BEGIN;

CREATE TABLE IF NOT EXISTS model_cards (
  id                          uuid         PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_name                text         NOT NULL,           -- e.g. 'mcp_askcos'
  model_version               text         NOT NULL,           -- e.g. 'condition_recommender@v2'
  defined_endpoint            text         NOT NULL,           -- OECD principle 1
  algorithm                   text         NOT NULL,           -- OECD principle 2
  applicability_domain        text         NOT NULL,           -- OECD principle 3
  predictivity_metrics        jsonb        NOT NULL DEFAULT '{}'::jsonb,  -- principle 4
  mechanistic_interpretation  text         NOT NULL DEFAULT '',           -- principle 5
  trained_on                  text         NOT NULL,           -- dataset citations
  trained_at                  timestamptz,                     -- nullable: external models
  shadow_until                timestamptz,                     -- Phase E shadow-serving window
  created_at                  timestamptz  NOT NULL DEFAULT NOW(),
  updated_at                  timestamptz  NOT NULL DEFAULT NOW(),
  UNIQUE (service_name, model_version)
);

DROP TRIGGER IF EXISTS trg_model_cards_updated_at ON model_cards;
CREATE TRIGGER trg_model_cards_updated_at
  BEFORE UPDATE ON model_cards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_model_cards_service
  ON model_cards(service_name);

CREATE INDEX IF NOT EXISTS idx_model_cards_shadow
  ON model_cards(shadow_until) WHERE shadow_until IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — model_cards is globally readable (catalog data, no project scope) but
-- only chemclaw_service can write. The standard ChemClaw pattern for
-- catalog tables: ENABLE + FORCE RLS, SELECT policy that requires the
-- per-request user setting to be non-empty (matches withSystemContext's
-- '__system__' sentinel and any real user). Writes are gated by GRANT;
-- chemclaw_app has SELECT only.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE model_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_cards FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS model_cards_select_authenticated ON model_cards;
CREATE POLICY model_cards_select_authenticated ON model_cards FOR SELECT
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  );

-- ────────────────────────────────────────────────────────────────────────────
-- Grants
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT ON model_cards TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON model_cards TO chemclaw_service;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Seed: ASKCOS condition recommender (Z0)
--
-- Algorithm + AD wording follows Coley group's 2018 paper + 2024 refresh
-- (arXiv 2501.01835). Predictivity metrics are the published top-k accuracy
-- numbers; trained_on names the canonical USPTO-derived training corpus.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO model_cards (
  service_name,
  model_version,
  defined_endpoint,
  algorithm,
  applicability_domain,
  predictivity_metrics,
  mechanistic_interpretation,
  trained_on
) VALUES (
  'mcp_askcos',
  'condition_recommender@v2',
  'Top-k condition sets {catalysts, reagents, solvents, temperature_c} for a target reaction (reactants + product SMILES).',
  'Neural network over Morgan fingerprints of reaction centers (Gao et al., ACS Cent. Sci. 2018) with the 2024 ASKCOS v2 refresh; predicts categorical condition slots and continuous temperature.',
  'Reactions whose center fingerprints have a near neighbor in USPTO 1976-2016 within Tanimoto >= 0.4. Coverage is uneven across reaction classes; OOD chemotypes should be routed to the literature-fallback skill.',
  '{"top_1_accuracy": 0.30, "top_10_accuracy_includes_ground_truth": 0.70, "temperature_mae_celsius": 20.0, "notes": "USPTO-held-out evaluation; uneven by reaction class"}'::jsonb,
  'No mechanistic causal model; conditions are predicted by analogy to nearest training reactions in fingerprint space. Temperature predictions are well-calibrated for common transition-metal couplings; less reliable for radical chemistry and unusual reaction classes.',
  'USPTO 1976-2016 (Lowe), filtered and curated by Coley group (Reaction_condition_recommendation repo)'
)
ON CONFLICT (service_name, model_version) DO NOTHING;

-- ── Z3 model_cards row ───────────────────────────────────────────────────

INSERT INTO model_cards (
  service_name, model_version, defined_endpoint, algorithm,
  applicability_domain, predictivity_metrics,
  mechanistic_interpretation, trained_on
) VALUES (
  'mcp_yield_baseline', 'yield_baseline_v1',
  'Per-reaction ensemble yield prediction with calibrated UQ. Returns ensemble_mean + ensemble_std plus chemprop and XGBoost component scores.',
  'Two-model ensemble: chemprop v2 MPNN with MVE head (aleatoric) + per-project XGBoost over DRFP fingerprints (epistemic via disagreement). Global pretrained XGBoost fallback when project has < 50 labels.',
  'Reactions whose DRFP fingerprints fall within the per-project training corpus when used_global_fallback=false; broader USPTO + ORD coverage when used_global_fallback=true.',
  '{"target_ece_global": 0.10, "evaluation_dataset": "Doyle Buchwald-Hartwig HTE (4608 reactions)"}'::jsonb,
  'Aleatoric uncertainty from chemprop MVE head; epistemic from chemprop-XGBoost disagreement. Components surfaced separately so chemists can act on each (high aleatoric -> noise; high epistemic -> unfamiliar chemotype).',
  'Per-project: experiments.yield_pct + reactions.rxn_smiles, RLS-scoped. Global fallback: USPTO + ORD subset, snapshot at image-build time.'
)
ON CONFLICT (service_name, model_version) DO NOTHING;

-- ── Z4 model_cards row ───────────────────────────────────────────────────

INSERT INTO model_cards (
  service_name, model_version, defined_endpoint, algorithm,
  applicability_domain, predictivity_metrics,
  mechanistic_interpretation, trained_on
) VALUES (
  'mcp_plate_designer', 'plate_designer_v1',
  'n-well DoE plate over a BoFire Domain of continuous + categorical factors. Returns wells with factor values + canonical Domain JSON for Z5 warm-start.',
  'BoFire space-filling sampling via domain.inputs.sample(n, seed). User exclusions and the built-in CHEM21 HighlyHazardous safety floor are applied as categorical-input restrictions before Domain construction.',
  'Any factor space the user can express as a Domain (continuous bounds + categorical lists). Plate capacity capped at 1536. Hazardous solvents auto-excluded unless disable_chem21_floor=true (logged for audit).',
  '{"sampling_strategy": "space_filling", "deterministic_seed": true}'::jsonb,
  'No mechanistic causal model. DoE is information-theoretic (space-filling). The chemist supplies the design space; the sampler covers it uniformly.',
  'BoFire 0.3.x DoE module. CHEM21 solvent classification from Prat et al., Green Chem. 2016 (built-in 24-solvent allowlist mirroring Z1).'
)
ON CONFLICT (service_name, model_version) DO NOTHING;

COMMIT;
