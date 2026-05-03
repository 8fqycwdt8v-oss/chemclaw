-- Phase 5 — focused-generation schema (mcp-genchem persistence + bioisostere rules + MMP).

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. gen_runs / gen_proposals
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gen_runs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind          TEXT NOT NULL CHECK (kind IN
                  ('scaffold','rgroup','mmp','bioisostere','grow','link','reinvent')),
  seed_smiles   TEXT,
  params        JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by  TEXT,
  status        TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  n_proposed    INTEGER NOT NULL DEFAULT 0,
  n_kept        INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_gen_runs_kind_created
  ON gen_runs (kind, created_at DESC);

CREATE TABLE IF NOT EXISTS gen_proposals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id          UUID NOT NULL REFERENCES gen_runs(id) ON DELETE CASCADE,
  smiles_canonical TEXT NOT NULL,
  inchikey        TEXT,
  parent_inchikey TEXT,
  transformation  JSONB NOT NULL DEFAULT '{}'::jsonb,
  scores          JSONB NOT NULL DEFAULT '{}'::jsonb,
  qm_job_id       UUID REFERENCES qm_jobs(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, inchikey)
);

CREATE INDEX IF NOT EXISTS idx_gen_proposals_run
  ON gen_proposals (run_id);
CREATE INDEX IF NOT EXISTS idx_gen_proposals_inchikey
  ON gen_proposals (inchikey) WHERE inchikey IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. bioisostere_rules — bi-temporal so curated rules can be deprecated
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bioisostere_rules (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         TEXT NOT NULL,
  lhs_smarts   TEXT NOT NULL,
  rhs_smiles   TEXT NOT NULL,
  source       TEXT,
  weight       NUMERIC(3,2) NOT NULL DEFAULT 1.00 CHECK (weight >= 0 AND weight <= 1),
  description  TEXT,
  valid_from   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bioisostere_rules_live
  ON bioisostere_rules (id) WHERE valid_to IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. mmp_pairs — backfill via a one-shot script over reactions corpus
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mmp_pairs (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lhs_inchikey          TEXT NOT NULL,
  rhs_inchikey          TEXT NOT NULL,
  transformation_smarts TEXT NOT NULL,
  delta_property        JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_experiment     UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (lhs_inchikey <> rhs_inchikey)
);

CREATE INDEX IF NOT EXISTS idx_mmp_pairs_lhs
  ON mmp_pairs (lhs_inchikey);
CREATE INDEX IF NOT EXISTS idx_mmp_pairs_rhs
  ON mmp_pairs (rhs_inchikey);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. RLS / grants
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT ON gen_runs, gen_proposals, bioisostere_rules, mmp_pairs
      TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON gen_runs, gen_proposals, bioisostere_rules, mmp_pairs
      TO chemclaw_service;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Seed bioisostere catalog — small representative set.
--    Source: classical pharma bioisostere lists (Patani & LaVoie 1996).
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO bioisostere_rules (name, lhs_smarts, rhs_smiles, source, weight, description) VALUES
  ('phenyl→pyridyl',         '[c]1[c][c][c][c][c]1', 'c1ccncc1', 'patani_lavoie', 0.85, 'Replace phenyl with pyridyl (improves solubility).'),
  ('OMe→F',                  '[OX2H0][CH3]',          'F',        'patani_lavoie', 0.7,  'Replace methoxy with fluorine.'),
  ('CH3→CF3',                '[CH3]',                  'C(F)(F)F', 'patani_lavoie', 0.6,  'Methyl→trifluoromethyl (metabolic-stability proxy).'),
  ('CO2H→tetrazole',         '[CX3](=O)[OX2H1]',       'c1nn[nH]n1', 'patani_lavoie', 0.8, 'Carboxylic acid → tetrazole (acidic isostere).'),
  ('amide→sulfonamide',      '[NX3;H1][CX3](=O)[#6]',  'NS(=O)(=O)C', 'patani_lavoie', 0.65, 'Replace amide with sulfonamide.'),
  ('OH→NH2',                 '[OX2H1][CH2]',           'N',          'patani_lavoie', 0.5, 'Hydroxyl→amine.')
ON CONFLICT DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Feature flag + permission policy
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO permission_policies (scope, scope_id, decision, tool_pattern, reason, created_by)
  VALUES ('global', '', 'allow', 'generate_focused_library', 'Library generation is read-only / additive; auto-allow with audit trail.', '__system__')
  ON CONFLICT DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. schema_version
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO schema_version (filename, applied_at)
  VALUES ('26_genchem.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
