-- Mock ELN — Postgres-backed mock ELN for hermetic testing + demo data.
-- Re-applicable: every CREATE is IF NOT EXISTS / DROP ... IF EXISTS first.
--
-- Companion file: db/init/31_fake_logs_schema.sql (analytical "fake LOGS").
-- Seed loader: db/seed/20_mock_eln_data.sql (gated by MOCK_ELN=on).
--
-- Design notes (see ~/.claude/plans/playful-honking-squid.md):
--   - One canonical row per reaction in mock_eln.reactions; OFAT variants
--     live in mock_eln.entries with the same reaction_id and per-entry
--     condition variation in fields_jsonb.conditions. Reaction-similarity
--     queries treat canonical reactions as the unit (200 OFAT entries → 1
--     hit with ofat_count=200), not 200 near-duplicates.
--   - entries.entry_shape ∈ {mixed, pure-structured, pure-freetext} drives
--     the mixed-vs-extreme distribution (80/7/8/5 → see plan).
--   - data_quality_tier is independent of entry_shape and applies to
--     structured fields (clean/partial/noisy/failed → 50/25/15/10).
--   - Read-only role chemclaw_mock_eln_reader is for the mcp_eln_local
--     MCP service. SELECT-only on all tables in this schema.

BEGIN;

-- --------------------------------------------------------------------
-- Schema
-- --------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS mock_eln;

-- --------------------------------------------------------------------
-- Read-only role for the mcp_eln_local MCP.
--
-- Password is taken from a postgres custom GUC (`chemclaw.mock_eln_reader_password`)
-- if set, else falls back to a dev placeholder. Production deployments
-- must override via `ALTER SYSTEM SET chemclaw.mock_eln_reader_password = '...'`
-- before this file applies, OR rotate the role password post-bootstrap
-- via the env var CHEMCLAW_MOCK_ELN_READER_PASSWORD wired into the
-- container entrypoint.
-- --------------------------------------------------------------------
DO $$
DECLARE
  v_provided_password TEXT := current_setting('chemclaw.mock_eln_reader_password', true);
  v_reader_password   TEXT;
BEGIN
  IF v_provided_password IS NULL OR v_provided_password = '' THEN
    -- No GUC set: fall back to the dev sentinel so `make db.init` works
    -- out of the box. This role only has SELECT on mock_eln + fake_logs
    -- (mock data, never production), but the dev password is well-known
    -- and operators must override it before exposing the service.
    RAISE NOTICE
      '[mock_eln] chemclaw.mock_eln_reader_password GUC is unset; '
      'creating chemclaw_mock_eln_reader with the DEV sentinel password. '
      'Override via: ALTER DATABASE chemclaw SET chemclaw.mock_eln_reader_password = ''<random>''; '
      'or: ALTER ROLE chemclaw_mock_eln_reader PASSWORD ''<random>''; '
      'BEFORE exposing the mcp-eln-local service to any non-dev caller.';
    v_reader_password := 'chemclaw_mock_eln_reader_dev_password_change_me';
  ELSE
    v_reader_password := v_provided_password;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_mock_eln_reader') THEN
    EXECUTE format(
      'CREATE ROLE chemclaw_mock_eln_reader WITH LOGIN NOBYPASSRLS PASSWORD %L',
      v_reader_password
    );
  END IF;
END $$;

GRANT USAGE ON SCHEMA mock_eln TO chemclaw_mock_eln_reader;

-- --------------------------------------------------------------------
-- projects (4 rows in seed)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mock_eln.projects (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code              TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  therapeutic_area  TEXT,
  started_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  pi_email          TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_mock_eln_projects_updated_at ON mock_eln.projects;
CREATE TRIGGER trg_mock_eln_projects_updated_at
  BEFORE UPDATE ON mock_eln.projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------
-- notebooks (~30 in seed)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mock_eln.notebooks (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id   UUID NOT NULL REFERENCES mock_eln.projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL
                 CHECK (kind IN ('discovery', 'process-dev', 'analytical')),
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_mock_eln_notebooks_updated_at ON mock_eln.notebooks;
CREATE TRIGGER trg_mock_eln_notebooks_updated_at
  BEFORE UPDATE ON mock_eln.notebooks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_mock_eln_notebooks_project
  ON mock_eln.notebooks (project_id);

-- --------------------------------------------------------------------
-- compounds (~600 in seed)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mock_eln.compounds (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  smiles_canonical  TEXT NOT NULL,
  inchikey          TEXT,
  mw                NUMERIC,
  external_id       TEXT,
  project_id        UUID REFERENCES mock_eln.projects(id) ON DELETE RESTRICT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mock_eln_compounds_project
  ON mock_eln.compounds (project_id);
CREATE INDEX IF NOT EXISTS idx_mock_eln_compounds_inchikey
  ON mock_eln.compounds (inchikey);
CREATE INDEX IF NOT EXISTS idx_mock_eln_compounds_external_id
  ON mock_eln.compounds (external_id);

-- --------------------------------------------------------------------
-- reactions — canonical only; OFAT variants live in entries.
-- (~150 in seed)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mock_eln.reactions (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  canonical_smiles_rxn   TEXT NOT NULL,
  family                 TEXT NOT NULL,
  step_number            INT,
  project_id             UUID NOT NULL REFERENCES mock_eln.projects(id) ON DELETE RESTRICT,
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mock_eln_reactions_project
  ON mock_eln.reactions (project_id);
CREATE INDEX IF NOT EXISTS idx_mock_eln_reactions_family
  ON mock_eln.reactions (family);

-- --------------------------------------------------------------------
-- entries (≥ 2000 in seed)
--
-- Schema-kind dimension: schema_kind tags the source-system-style shape
-- (e.g. ord-v0.3, signals-v1, freeform). entry_shape captures whether
-- structured fields, freetext, or both are populated. data_quality_tier
-- captures the structured-field quality independently of shape.
--
-- freetext_tsv is a STORED generated tsvector so the GIN index on full-
-- text search remains valid across inserts/updates without trigger code.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mock_eln.entries (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  notebook_id            UUID NOT NULL REFERENCES mock_eln.notebooks(id) ON DELETE CASCADE,
  project_id             UUID NOT NULL REFERENCES mock_eln.projects(id) ON DELETE RESTRICT,
  reaction_id            UUID REFERENCES mock_eln.reactions(id) ON DELETE RESTRICT,
  schema_kind            TEXT NOT NULL DEFAULT 'ord-v0.3',
  title                  TEXT NOT NULL,
  author_email           TEXT,
  signed_by              TEXT,
  status                 TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'in_progress', 'signed', 'witnessed', 'archived', 'cancelled')),
  entry_shape            TEXT NOT NULL
                           CHECK (entry_shape IN ('mixed', 'pure-structured', 'pure-freetext')),
  data_quality_tier      TEXT NOT NULL
                           CHECK (data_quality_tier IN ('clean', 'partial', 'noisy', 'failed')),
  fields_jsonb           JSONB NOT NULL DEFAULT '{}'::jsonb,
  freetext               TEXT,
  freetext_length_chars  INT NOT NULL DEFAULT 0,
  freetext_tsv           tsvector GENERATED ALWAYS AS (
                           to_tsvector('english', coalesce(freetext, ''))
                         ) STORED,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signed_at              TIMESTAMPTZ
);

DROP TRIGGER IF EXISTS trg_mock_eln_entries_modified_at ON mock_eln.entries;
CREATE OR REPLACE FUNCTION mock_eln.set_entry_modified_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.modified_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_mock_eln_entries_modified_at
  BEFORE UPDATE ON mock_eln.entries
  FOR EACH ROW EXECUTE FUNCTION mock_eln.set_entry_modified_at();

CREATE INDEX IF NOT EXISTS idx_mock_eln_entries_project_modified
  ON mock_eln.entries (project_id, modified_at DESC);
CREATE INDEX IF NOT EXISTS idx_mock_eln_entries_notebook
  ON mock_eln.entries (notebook_id);
CREATE INDEX IF NOT EXISTS idx_mock_eln_entries_reaction
  ON mock_eln.entries (reaction_id);
CREATE INDEX IF NOT EXISTS idx_mock_eln_entries_status
  ON mock_eln.entries (status);
CREATE INDEX IF NOT EXISTS idx_mock_eln_entries_entry_shape
  ON mock_eln.entries (entry_shape);
CREATE INDEX IF NOT EXISTS idx_mock_eln_entries_fields_gin
  ON mock_eln.entries USING gin (fields_jsonb);
CREATE INDEX IF NOT EXISTS idx_mock_eln_entries_freetext_gin
  ON mock_eln.entries USING gin (freetext_tsv);

-- --------------------------------------------------------------------
-- entry_attachments (~3500 in seed) — file metadata only, no binaries.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mock_eln.entry_attachments (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_id      UUID NOT NULL REFERENCES mock_eln.entries(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  mime_type     TEXT,
  size_bytes    BIGINT,
  description   TEXT,
  uri           TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mock_eln_attachments_entry
  ON mock_eln.entry_attachments (entry_id);

-- --------------------------------------------------------------------
-- methods (~30 in seed) — analytical method registry.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mock_eln.methods (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  instrument_kind TEXT,
  description     TEXT,
  parameters      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- --------------------------------------------------------------------
-- samples (~3000 in seed)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mock_eln.samples (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_id      UUID NOT NULL REFERENCES mock_eln.entries(id) ON DELETE CASCADE,
  sample_code   TEXT NOT NULL,
  compound_id   UUID REFERENCES mock_eln.compounds(id) ON DELETE RESTRICT,
  amount_mg     NUMERIC,
  purity_pct    NUMERIC,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entry_id, sample_code)
);

CREATE INDEX IF NOT EXISTS idx_mock_eln_samples_entry
  ON mock_eln.samples (entry_id);
CREATE INDEX IF NOT EXISTS idx_mock_eln_samples_compound
  ON mock_eln.samples (compound_id);
CREATE INDEX IF NOT EXISTS idx_mock_eln_samples_code
  ON mock_eln.samples (sample_code);

-- --------------------------------------------------------------------
-- results (~5000 in seed) — analytical results per sample.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mock_eln.results (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sample_id    UUID NOT NULL REFERENCES mock_eln.samples(id) ON DELETE CASCADE,
  method_id    UUID REFERENCES mock_eln.methods(id) ON DELETE RESTRICT,
  metric       TEXT NOT NULL,
  value_num    NUMERIC,
  value_text   TEXT,
  unit         TEXT,
  measured_at  TIMESTAMPTZ,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mock_eln_results_sample
  ON mock_eln.results (sample_id);
CREATE INDEX IF NOT EXISTS idx_mock_eln_results_metric
  ON mock_eln.results (metric);

-- --------------------------------------------------------------------
-- audit_trail (~12000 in seed) — append-only mutation history.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mock_eln.audit_trail (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_id        UUID REFERENCES mock_eln.entries(id) ON DELETE CASCADE,
  actor_email     TEXT,
  action          TEXT NOT NULL,
  field_path      TEXT,
  old_value       JSONB,
  new_value       JSONB,
  reason          TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mock_eln_audit_entry
  ON mock_eln.audit_trail (entry_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_mock_eln_audit_action
  ON mock_eln.audit_trail (action);

-- --------------------------------------------------------------------
-- View: canonical_reactions_with_ofat
--
-- Aggregates entries-per-canonical-reaction so OFAT-aware queries hit
-- one row per canonical reaction (rather than 200 near-duplicates).
-- mean_yield reads the conventional fields_jsonb.results.yield_pct path
-- when present and numeric, else NULL.
--
-- Failed/cancelled entries are excluded from mean_yield because their
-- yield_pct is sentinel-zero (the seed generator records yield=0 for
-- data_quality_tier='failed' rows). Including them dragged the mean
-- ~8% low on campaigns with a typical 8–10% failed-tier rate.
-- --------------------------------------------------------------------
CREATE OR REPLACE VIEW mock_eln.canonical_reactions_with_ofat AS
SELECT
  r.id                              AS reaction_id,
  r.canonical_smiles_rxn,
  r.family,
  r.project_id,
  r.step_number,
  COUNT(e.id)                       AS ofat_count,
  AVG(
    CASE
      WHEN jsonb_typeof(e.fields_jsonb -> 'results' -> 'yield_pct') = 'number'
       AND e.data_quality_tier <> 'failed'
       AND e.status <> 'cancelled'
        THEN (e.fields_jsonb -> 'results' ->> 'yield_pct')::numeric
      ELSE NULL
    END
  )                                 AS mean_yield,
  MAX(e.modified_at)                AS last_activity_at
FROM mock_eln.reactions r
LEFT JOIN mock_eln.entries e ON e.reaction_id = r.id
GROUP BY r.id, r.canonical_smiles_rxn, r.family, r.project_id, r.step_number;

-- --------------------------------------------------------------------
-- Grants — read-only role gets SELECT on everything (tables + view).
-- Default privileges ensure tables added later inherit SELECT for the
-- reader role automatically.
-- --------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA mock_eln TO chemclaw_mock_eln_reader;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA mock_eln TO chemclaw_mock_eln_reader;

ALTER DEFAULT PRIVILEGES IN SCHEMA mock_eln
  GRANT SELECT ON TABLES TO chemclaw_mock_eln_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA mock_eln
  GRANT SELECT ON SEQUENCES TO chemclaw_mock_eln_reader;

-- chemclaw_service (BYPASSRLS, system workers) needs full access for
-- seed loading and any future projector that derives from mock_eln.
GRANT USAGE ON SCHEMA mock_eln TO chemclaw_service;
GRANT ALL ON ALL TABLES    IN SCHEMA mock_eln TO chemclaw_service;
GRANT ALL ON ALL SEQUENCES IN SCHEMA mock_eln TO chemclaw_service;

ALTER DEFAULT PRIVILEGES IN SCHEMA mock_eln
  GRANT ALL ON TABLES    TO chemclaw_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA mock_eln
  GRANT ALL ON SEQUENCES TO chemclaw_service;

COMMIT;
