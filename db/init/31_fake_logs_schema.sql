-- Fake LOGS — Postgres-backed fake LOGS-by-SciY SDMS for hermetic testing.
-- Re-applicable: every CREATE is IF NOT EXISTS / DROP ... IF EXISTS first.
--
-- Companion file: db/init/30_mock_eln_schema.sql (mock ELN).
-- Seed loader: db/seed/21_fake_logs_data.sql (gated by LOGS_BACKEND=fake-postgres).
--
-- Design notes (see ~/.claude/plans/playful-honking-squid.md):
--   - This schema simulates a "different system" — LOGS is a separate
--     SDMS in production, so we deliberately do NOT FK project_code to
--     mock_eln.projects.code. The link is text-only and resolved by the
--     agent / cross-source queries, not by the DB.
--   - Parameters live on datasets.parameters_jsonb (single JSONB column,
--     not a separate parameters_kv table). Rationale: vendor parameter
--     bags (Bruker / Waters / Agilent etc.) are deeply nested and rarely
--     queried by individual key; flat JSONB with a GIN index gives both
--     ergonomics for the MCP and good filter performance.
--   - dataset_files records mime/size only (no binary content). Binary
--     fetches go through the doc-fetcher path — see plan §Tracks.
--   - tracks carries per-detector summary peak data for HPLC/MS/etc.
--   - persons mirrors the LOGS Person API (operators) for parity.
--   - Same chemclaw_mock_eln_reader role (created in 30_mock_eln_schema.sql)
--     gets SELECT on this schema too — one MCP serves both.

BEGIN;

-- --------------------------------------------------------------------
-- Schema
-- --------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS fake_logs;

-- The reader role is created in 30_mock_eln_schema.sql; we just guard
-- in case 31 is applied alone (e.g. partial migration replay).
DO $$
DECLARE
  v_reader_password TEXT := coalesce(
    current_setting('chemclaw.mock_eln_reader_password', true),
    'chemclaw_mock_eln_reader_dev_password_change_me'
  );
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_mock_eln_reader') THEN
    EXECUTE format(
      'CREATE ROLE chemclaw_mock_eln_reader WITH LOGIN NOBYPASSRLS PASSWORD %L',
      v_reader_password
    );
  END IF;
END $$;

GRANT USAGE ON SCHEMA fake_logs TO chemclaw_mock_eln_reader;

-- --------------------------------------------------------------------
-- persons — LOGS Person API parity (operators).
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fake_logs.persons (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username     TEXT UNIQUE NOT NULL,
  display_name TEXT,
  email        TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- --------------------------------------------------------------------
-- datasets — central canonical table mirroring the LogsDataset model.
--
-- uid is the LOGS UID (text PK matching the LOGS UID format). project_code
-- is text-only (no FK to mock_eln) by design — see header note.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fake_logs.datasets (
  uid                TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  instrument_kind    TEXT NOT NULL
                       CHECK (instrument_kind IN ('HPLC', 'NMR', 'MS', 'GC-MS', 'LC-MS', 'IR')),
  instrument_serial  TEXT,
  method_name        TEXT,
  sample_id          TEXT,
  sample_name        TEXT,
  operator           TEXT,
  measured_at        TIMESTAMPTZ NOT NULL,
  parameters_jsonb   JSONB NOT NULL DEFAULT '{}'::jsonb,
  project_code       TEXT,
  citation_uri       TEXT,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_fake_logs_datasets_updated_at ON fake_logs.datasets;
CREATE TRIGGER trg_fake_logs_datasets_updated_at
  BEFORE UPDATE ON fake_logs.datasets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_fake_logs_datasets_kind_measured
  ON fake_logs.datasets (instrument_kind, measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_fake_logs_datasets_sample
  ON fake_logs.datasets (sample_id);
CREATE INDEX IF NOT EXISTS idx_fake_logs_datasets_project_code
  ON fake_logs.datasets (project_code);
CREATE INDEX IF NOT EXISTS idx_fake_logs_datasets_parameters_gin
  ON fake_logs.datasets USING gin (parameters_jsonb);

-- --------------------------------------------------------------------
-- tracks — per-detector summary peak data (HPLC/MS multi-detector etc.).
-- Peak summary kept as JSONB (rt, area, height, name, m/z) — schema is
-- vendor-shape-fluid, and aggregation is on the dataset side.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fake_logs.tracks (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dataset_uid  TEXT NOT NULL REFERENCES fake_logs.datasets(uid) ON DELETE CASCADE,
  track_index  INT NOT NULL,
  detector     TEXT,
  unit         TEXT,
  peaks_jsonb  JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dataset_uid, track_index)
);

CREATE INDEX IF NOT EXISTS idx_fake_logs_tracks_dataset
  ON fake_logs.tracks (dataset_uid);

-- --------------------------------------------------------------------
-- dataset_files — file metadata only (mime/size). No binary payloads.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fake_logs.dataset_files (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dataset_uid  TEXT NOT NULL REFERENCES fake_logs.datasets(uid) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  mime_type    TEXT,
  size_bytes   BIGINT,
  description  TEXT,
  uri          TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fake_logs_dataset_files_dataset
  ON fake_logs.dataset_files (dataset_uid);

-- --------------------------------------------------------------------
-- Grants — same chemclaw_mock_eln_reader serves both schemas.
-- chemclaw_service (system workers) gets full access for seed loading.
-- --------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA fake_logs TO chemclaw_mock_eln_reader;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA fake_logs TO chemclaw_mock_eln_reader;

ALTER DEFAULT PRIVILEGES IN SCHEMA fake_logs
  GRANT SELECT ON TABLES TO chemclaw_mock_eln_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA fake_logs
  GRANT SELECT ON SEQUENCES TO chemclaw_mock_eln_reader;

GRANT USAGE ON SCHEMA fake_logs TO chemclaw_service;
GRANT ALL ON ALL TABLES    IN SCHEMA fake_logs TO chemclaw_service;
GRANT ALL ON ALL SEQUENCES IN SCHEMA fake_logs TO chemclaw_service;

ALTER DEFAULT PRIVILEGES IN SCHEMA fake_logs
  GRANT ALL ON TABLES    TO chemclaw_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA fake_logs
  GRANT ALL ON SEQUENCES TO chemclaw_service;

COMMIT;
