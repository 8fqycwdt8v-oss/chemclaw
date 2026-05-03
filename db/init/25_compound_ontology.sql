-- Phase 4 — compound ontology and auto-classification.
--
-- Sits on top of Phase 3's compound_substructure_hits + Morgan fingerprints
-- so the classifier projector can answer "what is this compound?" without
-- re-running RDKit on every assignment. Bi-temporal — class assignments are
-- not deleted; they're closed via valid_to so the audit trail is intact.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. compound_classes — chemotype catalog (richer than compound_smarts_catalog)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compound_classes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL UNIQUE,
  role              TEXT NOT NULL CHECK (role IN (
                      'ligand', 'catalyst', 'solvent', 'reagent',
                      'substrate', 'protecting_group', 'additive',
                      'base', 'acid', 'oxidant', 'reductant'
                    )),
  family            TEXT,
  smarts_rule_names TEXT[] NOT NULL DEFAULT '{}'::text[],
  smarts_inline     TEXT[] NOT NULL DEFAULT '{}'::text[],
  fingerprint_seeds TEXT[] NOT NULL DEFAULT '{}'::text[],  -- inchikeys of canonical exemplars
  priority          INTEGER NOT NULL DEFAULT 100,
  source            TEXT,
  description       TEXT,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compound_classes_role
  ON compound_classes (role) WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_compound_classes_family
  ON compound_classes (family) WHERE enabled = TRUE;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. compound_class_assignments — bi-temporal junction
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compound_class_assignments (
  inchikey       TEXT NOT NULL REFERENCES compounds(inchikey) ON DELETE CASCADE,
  class_id       UUID NOT NULL REFERENCES compound_classes(id) ON DELETE CASCADE,
  confidence     NUMERIC(4,3) NOT NULL CHECK (confidence >= 0.000 AND confidence <= 1.000),
  evidence       JSONB NOT NULL DEFAULT '{}'::jsonb,
  valid_from     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to       TIMESTAMPTZ,
  PRIMARY KEY (inchikey, class_id, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_compound_class_assignments_inchikey
  ON compound_class_assignments (inchikey) WHERE valid_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_compound_class_assignments_class_live
  ON compound_class_assignments (class_id) WHERE valid_to IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. RLS / grants
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT ON compound_classes, compound_class_assignments TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON compound_classes, compound_class_assignments
      TO chemclaw_service;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Seed catalog — common pharma roles + families.
--    Each class references SMARTS rules by NAME (foreign references the
--    compound_smarts_catalog seeded in 24_compound_fingerprints.sql).
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO compound_classes (name, role, family, smarts_rule_names, priority, source, description) VALUES
  ('Tertiary phosphine ligand',
     'ligand',  'phosphine',          ARRAY['phosphine_tertiary'], 10,
     'curated', 'Trialkyl/triaryl phosphine — generic Pd/Ru/Ir donor.'),
  ('Buchwald biaryl phosphine',
     'ligand',  'biaryl_phosphine',   ARRAY['biaryl_phosphine'], 5,
     'curated', 'Buchwald-style biaryl phosphine; supersedes generic phosphine when matched.'),
  ('NHC ligand precursor',
     'ligand',  'NHC',                ARRAY['nhc'], 10,
     'curated', 'Imidazolium / NHC precursor.'),
  ('Primary amine reagent',
     'reagent', 'amine_primary',      ARRAY['primary_amine'], 50,
     'curated', 'Primary amine (Buchwald-Hartwig coupling partner; reductive amination etc).'),
  ('Secondary amine reagent',
     'reagent', 'amine_secondary',    ARRAY['secondary_amine'], 50,
     'curated', 'Secondary amine.'),
  ('Aryl halide substrate',
     'reagent', 'aryl_halide',        ARRAY['aryl_halide'], 30,
     'curated', 'Aryl-X (cross-coupling electrophile).'),
  ('Boronic acid coupling partner',
     'reagent', 'boronic_acid',       ARRAY['boronic_acid'], 30,
     'curated', 'Boronic acid (Suzuki nucleophile).'),
  ('Pinacol boronic ester',
     'reagent', 'boronic_ester_pin',  ARRAY['boronic_ester'], 30,
     'curated', 'Bpin coupling partner.'),
  ('Carboxylic acid',
     'reagent', 'acid',               ARRAY['carboxylic_acid'], 50,
     'curated', 'Free carboxylic acid (amide coupling, esterification).'),
  ('Aldehyde',
     'reagent', 'aldehyde',           ARRAY['aldehyde'], 60,
     'curated', 'Aldehyde.'),
  ('Polar aprotic solvent (DMSO)',
     'solvent', 'dmso',               ARRAY['solvent_dmso'], 5,
     'curated', 'DMSO.'),
  ('Polar aprotic solvent (DMF)',
     'solvent', 'dmf',                ARRAY['solvent_dmf'], 5,
     'curated', 'DMF.'),
  ('Ethereal solvent',
     'solvent', 'ether',              ARRAY['solvent_ether'], 50,
     'curated', 'Generic ether (THF, dioxane, MTBE...).'),
  ('Water',
     'solvent', 'water',              ARRAY['solvent_water'], 5,
     'curated', 'Water.')
ON CONFLICT (name) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. schema_version
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO schema_version (filename, applied_at)
  VALUES ('25_compound_ontology.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
