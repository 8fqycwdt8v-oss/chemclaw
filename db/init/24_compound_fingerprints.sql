-- Phase 3 — compound fingerprints + SMARTS catalog + substructure-hit cache.
--
-- Foundation for compound-level similarity search ("find compounds similar to
-- BINAP") and class-based queries ("list all phosphines"). Adds vector columns
-- on the existing `compounds` table (additive, no readers broken) plus two
-- new tables: `compound_smarts_catalog` (curated SMARTS rules) and
-- `compound_substructure_hits` (which compound matches which catalog rule).
--
-- The `compound_fingerprinter` projector watches `compound_changed` NOTIFYs
-- and populates fingerprint vectors + the substructure-hits cache.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Fingerprint columns on `compounds` (additive)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE compounds
  ADD COLUMN IF NOT EXISTS morgan_r2          vector(2048),
  ADD COLUMN IF NOT EXISTS morgan_r3          vector(2048),
  ADD COLUMN IF NOT EXISTS maccs              vector(167),
  ADD COLUMN IF NOT EXISTS atompair           vector(2048),
  ADD COLUMN IF NOT EXISTS scaffold_smiles    TEXT,
  ADD COLUMN IF NOT EXISTS scaffold_inchikey  TEXT,
  ADD COLUMN IF NOT EXISTS fp_version         TEXT,
  ADD COLUMN IF NOT EXISTS fp_computed_at     TIMESTAMPTZ;

-- pgvector indices: ivfflat (cosine) for the 2048-dim families. Lists chosen
-- as sqrt(N) heuristic; tune in a follow-up after corpus reaches stable size.
CREATE INDEX IF NOT EXISTS idx_compounds_morgan_r2
  ON compounds USING ivfflat (morgan_r2 vector_cosine_ops)
  WITH (lists = 50);

CREATE INDEX IF NOT EXISTS idx_compounds_morgan_r3
  ON compounds USING ivfflat (morgan_r3 vector_cosine_ops)
  WITH (lists = 50);

CREATE INDEX IF NOT EXISTS idx_compounds_atompair
  ON compounds USING ivfflat (atompair vector_cosine_ops)
  WITH (lists = 50);

-- MACCS is small enough that a HNSW or a sequential scan is fine for the
-- corpus sizes we care about; default to ivfflat with small lists.
CREATE INDEX IF NOT EXISTS idx_compounds_maccs
  ON compounds USING ivfflat (maccs vector_cosine_ops)
  WITH (lists = 20);

CREATE INDEX IF NOT EXISTS idx_compounds_scaffold_inchikey
  ON compounds (scaffold_inchikey) WHERE scaffold_inchikey IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. compound_smarts_catalog — curated class definitions
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compound_smarts_catalog (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL UNIQUE,
  smarts       TEXT NOT NULL,
  role         TEXT,
  family       TEXT,
  source       TEXT,
  description  TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  priority     INTEGER NOT NULL DEFAULT 100,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compound_smarts_catalog_role_family
  ON compound_smarts_catalog (role, family) WHERE enabled = TRUE;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. compound_substructure_hits — projector cache
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compound_substructure_hits (
  inchikey     TEXT NOT NULL REFERENCES compounds(inchikey) ON DELETE CASCADE,
  smarts_id    UUID NOT NULL REFERENCES compound_smarts_catalog(id) ON DELETE CASCADE,
  n_matches    INTEGER NOT NULL DEFAULT 0,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (inchikey, smarts_id)
);

CREATE INDEX IF NOT EXISTS idx_compound_substructure_hits_smarts
  ON compound_substructure_hits (smarts_id, n_matches DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. NOTIFY trigger — pg_notify('compound_changed', inchikey) on canonical writes
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION notify_compound_changed() RETURNS TRIGGER AS $$
BEGIN
  -- Only re-fingerprint when the structural identity changes.
  IF TG_OP = 'INSERT'
     OR (TG_OP = 'UPDATE'
         AND NEW.smiles_canonical IS DISTINCT FROM OLD.smiles_canonical) THEN
    PERFORM pg_notify('compound_changed', NEW.inchikey);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_compound_changed ON compounds;
CREATE TRIGGER trg_notify_compound_changed
  AFTER INSERT OR UPDATE OF smiles_canonical ON compounds
  FOR EACH ROW EXECUTE FUNCTION notify_compound_changed();

-- ────────────────────────────────────────────────────────────────────────────
-- 5. RLS / grants — chemistry is global
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT ON compound_smarts_catalog, compound_substructure_hits
      TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON compound_smarts_catalog, compound_substructure_hits
      TO chemclaw_service;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Seed catalog with a representative pharma SMARTS bundle.
--    The full catalog ships in sample-data/smarts_catalog.yaml; the loader
--    script (services/projectors/compound_fingerprinter/seed.py) idempotently
--    upserts that file. Seeding here gives a working out-of-the-box default
--    so the agent can answer "list all phosphines" the moment the schema is
--    applied — without waiting for the projector seed to run.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO compound_smarts_catalog (name, smarts, role, family, source, description) VALUES
  ('phosphine_tertiary',  '[PX3]([#6])([#6])[#6]',          'ligand',   'phosphine',          'curated', 'Trialkyl/triaryl phosphine donor.'),
  ('biaryl_phosphine',    '[#6][PX3]([#6])([c]1[c][c][c][c][c]1)',  'ligand', 'biaryl_phosphine', 'curated', 'Buchwald-style biaryl phosphine.'),
  ('nhc',                 '[#6;X3]1=[#7][#6]=,:[#6][#7]1',  'ligand',   'NHC',                'curated', 'N-heterocyclic carbene precursor (imidazolium) — heuristic.'),
  ('primary_amine',       '[NX3;H2;!$(NC=O)]',              'reagent',  'amine_primary',      'curated', 'Primary amine excluding amides.'),
  ('secondary_amine',     '[NX3;H1;!$(NC=O)]([#6])[#6]',    'reagent',  'amine_secondary',    'curated', 'Secondary amine excluding amides.'),
  ('aryl_halide',         '[c][F,Cl,Br,I]',                  'reagent',  'aryl_halide',        'curated', 'Aryl-X ready for cross-coupling.'),
  ('boronic_acid',        '[c,C][B](O)O',                   'reagent',  'boronic_acid',       'curated', 'Aryl/alkyl boronic acid.'),
  ('boronic_ester',       '[c,C][B]1OC(C)(C)C(C)(C)O1',     'reagent',  'boronic_ester_pin',  'curated', 'Pinacol boronic ester (Bpin).'),
  ('carboxylic_acid',     '[CX3](=O)[OX2H1]',               'reagent',  'acid',               'curated', 'Free carboxylic acid.'),
  ('amide_secondary',     '[NX3;H1;$(NC=O)]',               'product',  'amide_secondary',    'curated', 'Secondary amide N-H.'),
  ('alcohol_primary',     '[CH2;X4][OH1]',                  'reagent',  'alcohol_primary',    'curated', 'Primary alcohol.'),
  ('aldehyde',            '[CX3H1](=O)[#6]',                'reagent',  'aldehyde',           'curated', 'Aldehyde.'),
  ('ketone',              '[CX3](=O)([#6])[#6]',            'reagent',  'ketone',             'curated', 'Ketone.'),
  ('nitrile',             '[CX2]#[NX1]',                     'reagent',  'nitrile',            'curated', 'Nitrile.'),
  ('terminal_alkyne',     '[CX2;H1]#[CX2]',                  'reagent',  'alkyne_terminal',    'curated', 'Terminal alkyne (Sonogashira-ready).'),
  ('solvent_dmso',        '[CH3][SX3](=O)[CH3]',            'solvent',  'dmso',               'curated', 'DMSO solvent SMARTS marker.'),
  ('solvent_dmf',         'CN(C)C=O',                        'solvent',  'dmf',                'curated', 'DMF solvent SMARTS marker.'),
  ('solvent_ether',       '[#6][OX2][#6]',                  'solvent',  'ether',              'curated', 'Generic ether (matches THF, dioxane, MeOMe...).'),
  ('solvent_water',       '[OH2]',                           'solvent',  'water',              'curated', 'Water.'),
  ('halide_alkyl',        '[CX4][F,Cl,Br,I]',               'reagent',  'alkyl_halide',       'curated', 'Alkyl halide.')
ON CONFLICT (name) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. schema_version
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO schema_version (filename, applied_at)
  VALUES ('24_compound_fingerprints.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
