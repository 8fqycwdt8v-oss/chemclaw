-- Phase 7 — chemical-space screens (one of the two "powerful multipliers").
--
-- A screen takes a candidate set (from a SMARTS query, a class, a generation
-- run, or a literal list), runs a configurable scoring pipeline (xTB SP /
-- opt / descriptors / fingerprint distance), and ranks the top_k. Backed
-- by the Phase 6 task queue.

BEGIN;

CREATE TABLE IF NOT EXISTS chemspace_screens (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name              TEXT NOT NULL,
  candidate_source  JSONB NOT NULL,
  candidate_count   INTEGER NOT NULL DEFAULT 0,
  scoring_pipeline  JSONB NOT NULL,
  batch_id          UUID REFERENCES task_batches(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_chemspace_screens_status_created
  ON chemspace_screens (status, created_at DESC);

CREATE TABLE IF NOT EXISTS chemspace_results (
  screen_id    UUID NOT NULL REFERENCES chemspace_screens(id) ON DELETE CASCADE,
  inchikey     TEXT NOT NULL,
  scores       JSONB NOT NULL DEFAULT '{}'::jsonb,
  rank         INTEGER NOT NULL DEFAULT 0,
  qm_job_ids   UUID[] NOT NULL DEFAULT '{}'::uuid[],
  PRIMARY KEY (screen_id, inchikey)
);

CREATE INDEX IF NOT EXISTS idx_chemspace_results_rank
  ON chemspace_results (screen_id, rank);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT, INSERT, UPDATE ON chemspace_screens, chemspace_results TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON chemspace_screens, chemspace_results TO chemclaw_service;
  END IF;
END $$;

INSERT INTO permission_policies (scope, scope_id, decision, tool_pattern, reason, created_by)
  VALUES
    ('global', '', 'allow', 'run_chemspace_screen', 'Read-additive (writes a screen + ranked results); auto-allow.', '__system__'),
    ('global', '', 'allow', 'conformer_aware_kg_query', 'Read-only KG traversal.', '__system__')
  ON CONFLICT DO NOTHING;

INSERT INTO schema_version (filename, applied_at)
  VALUES ('28_screens.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
