-- Phase Z6 — analytical-development column inventory.
--
-- Globally-readable catalogue of reversed-phase HPLC/UHPLC columns with
-- Tanaka 6-axis selectivity descriptors and operating-envelope limits.
-- Used by the chromatography method-optimization MCP to construct a
-- BoFire CategoricalDescriptorInput("column", ...) so the GP surrogate
-- can interpolate selectivity across columns rather than treating each
-- as a fully-novel category.
--
-- No RLS — column SKUs are public catalogue data shared across projects.
--
-- Re-applicable: IF NOT EXISTS guards everywhere.

BEGIN;

CREATE TABLE IF NOT EXISTS column_inventory (
  id                    uuid         PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor                text         NOT NULL,
  product_line          text         NOT NULL,
  chemistry             text         NOT NULL,
  particle_size_um      numeric(3,2) NOT NULL,
  pore_size_A           int          NOT NULL,
  dimensions_mm         text         NOT NULL,
  -- Tanaka 6-axis descriptor vector (NULL allowed when uncharacterised).
  tanaka_kPB            numeric(5,2),
  tanaka_alphaCH2       numeric(5,3),
  tanaka_alphaT_O       numeric(5,3),
  tanaka_alphaC_P       numeric(5,3),
  tanaka_alphaB_P_pH27  numeric(5,3),
  tanaka_alphaB_P_pH76  numeric(5,3),
  -- operating envelope (per-column conditional bounds resolved at domain build).
  pH_min                numeric(3,1) NOT NULL,
  pH_max                numeric(3,1) NOT NULL,
  T_max_C               numeric(4,1) NOT NULL,
  flow_max_mLmin        numeric(3,2) NOT NULL,
  pressure_max_bar      int          NOT NULL,
  is_msc                boolean      NOT NULL DEFAULT false,
  source_doc_uri        text,
  active                boolean      NOT NULL DEFAULT true,
  created_at            timestamptz  NOT NULL DEFAULT NOW(),
  UNIQUE (vendor, product_line, chemistry, particle_size_um, dimensions_mm)
);

CREATE INDEX IF NOT EXISTS idx_column_inventory_active
  ON column_inventory(active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_column_inventory_chemistry
  ON column_inventory(chemistry) WHERE active = true;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT ON column_inventory TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON column_inventory TO chemclaw_service;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Initial catalogue — 17 reversed-phase columns spanning the standard
-- selectivity classes used in pharma analytical-development screens:
--   alkyl C18 (3) · phenyl-class (3) · PFP (2) · polar-embedded / endcapped (3)
--   core-shell C18 (3) · ARC-18 (1) · EVO Polar + Eclipse (2)
-- Tanaka descriptors are representative published / vendor PDS values; treat
-- as illustrative for the surrogate kernel — re-measure against an in-house
-- Tanaka test for production use.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO column_inventory (
  vendor, product_line, chemistry, particle_size_um, pore_size_A, dimensions_mm,
  tanaka_kPB, tanaka_alphaCH2, tanaka_alphaT_O, tanaka_alphaC_P,
  tanaka_alphaB_P_pH27, tanaka_alphaB_P_pH76,
  pH_min, pH_max, T_max_C, flow_max_mLmin, pressure_max_bar, is_msc, source_doc_uri
) VALUES
  -- Alkyl C18
  ('Waters',     'Acquity BEH',     'C18',           1.70,  130, '2.1x50',
   3.30, 1.480, 1.500, 0.420, 0.190, 0.290,
   1.0, 12.0, 80.0,  1.00, 1034, true,  'https://www.waters.com/'),
  ('Waters',     'CSH',             'C18',           1.70,  130, '2.1x50',
   3.10, 1.470, 1.480, 0.500, 0.150, 0.470,
   1.0, 11.0, 90.0,  1.00, 1034, true,  'https://www.waters.com/'),
  ('Waters',     'HSS',             'T3',            1.80,  100, '2.1x50',
   3.55, 1.490, 1.520, 0.430, 0.090, 0.410,
   2.0,  8.0, 80.0,  1.00, 1034, true,  'https://www.waters.com/'),
  -- Phenyl-class
  ('Waters',     'Acquity BEH',     'Phenyl',        1.70,  130, '2.1x50',
   2.30, 1.450, 1.510, 0.580, 0.230, 0.370,
   1.0, 12.0, 80.0,  1.00, 1034, true,  'https://www.waters.com/'),
  ('Waters',     'CSH',             'Phenyl-Hexyl',  1.70,  130, '2.1x50',
   2.50, 1.460, 1.500, 0.620, 0.190, 0.520,
   1.0, 11.0, 90.0,  1.00, 1034, true,  'https://www.waters.com/'),
  ('Phenomenex', 'Kinetex',         'Biphenyl',      2.60,  100, '2.1x50',
   2.65, 1.450, 1.510, 0.640, 0.260, 0.490,
   1.5,  8.5, 60.0,  1.50,  600, true,  'https://www.phenomenex.com/'),
  -- PFP
  ('Phenomenex', 'Kinetex',         'F5',            2.60,  100, '2.1x50',
   1.85, 1.350, 1.460, 0.730, 0.480, 0.610,
   1.5,  8.5, 60.0,  1.50,  600, true,  'https://www.phenomenex.com/'),
  ('Restek',     'Raptor',          'F5',            2.70,   90, '2.1x50',
   1.95, 1.360, 1.470, 0.710, 0.450, 0.600,
   2.0,  8.0, 80.0,  1.50,  600, true,  'https://www.restek.com/'),
  -- Polar-embedded / endcapped
  ('Agilent',    'ZORBAX',          'Bonus-RP',      1.80,   80, '2.1x50',
   2.85, 1.430, 1.470, 0.530, 0.270, 0.440,
   2.0,  9.0, 60.0,  1.00, 1200, true,  'https://www.agilent.com/'),
  ('Phenomenex', 'Polar',           'C18',           1.70,  100, '2.1x50',
   3.00, 1.460, 1.490, 0.500, 0.200, 0.400,
   1.5,  8.0, 60.0,  1.00, 1000, true,  'https://www.phenomenex.com/'),
  ('Waters',     'HSS',             'Cyano',         1.80,  100, '2.1x50',
   1.20, 1.300, 1.420, 0.640, 0.310, 0.380,
   1.0,  8.0, 60.0,  1.00, 1034, true,  'https://www.waters.com/'),
  -- Core-shell C18
  ('Phenomenex', 'Kinetex',         'EVO C18',       2.60,  100, '2.1x50',
   3.20, 1.480, 1.510, 0.460, 0.140, 0.310,
   1.0, 12.0, 60.0,  1.50,  600, true,  'https://www.phenomenex.com/'),
  ('Agilent',    'Poroshell',       'HPH-C18',       2.70,  120, '2.1x50',
   3.25, 1.470, 1.500, 0.470, 0.180, 0.330,
   2.0, 11.0, 80.0,  1.50,  600, true,  'https://www.agilent.com/'),
  ('Waters',     'Cortecs',         'T3',            1.60,   90, '2.1x50',
   3.40, 1.470, 1.510, 0.450, 0.110, 0.380,
   2.0,  8.0, 60.0,  1.20, 1000, true,  'https://www.waters.com/'),
  -- ARC-18
  ('Restek',     'Raptor',          'ARC-18',        2.70,   90, '2.1x50',
   3.10, 1.480, 1.500, 0.480, 0.160, 0.420,
   1.0,  8.0, 80.0,  1.50,  600, true,  'https://www.restek.com/'),
  -- EVO Polar + Eclipse
  ('Phenomenex', 'Kinetex',         'EVO Polar C18', 2.60,  100, '2.1x50',
   2.95, 1.460, 1.500, 0.540, 0.220, 0.450,
   1.0, 12.0, 60.0,  1.50,  600, true,  'https://www.phenomenex.com/'),
  ('Agilent',    'ZORBAX',          'Eclipse C18',   1.80,   95, '2.1x50',
   3.15, 1.470, 1.490, 0.470, 0.170, 0.350,
   2.0,  9.0, 60.0,  1.00, 1200, true,  'https://www.agilent.com/')
ON CONFLICT (vendor, product_line, chemistry, particle_size_um, dimensions_mm)
  DO NOTHING;

INSERT INTO schema_version (filename, applied_at)
  VALUES ('54_column_inventory.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
