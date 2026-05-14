-- db/init/64_investigation_queue.sql
--
-- Universal Knowledge Accumulation — Phase 0
-- Scored deferred work for the investigation_scorer/interpreter chain.
-- High-score facts (>= investigation.score_threshold_sync) bypass the queue;
-- low-score facts land here for the periodic sweep.

BEGIN;

CREATE TABLE IF NOT EXISTS investigation_queue (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fact_id       UUID NOT NULL REFERENCES facts(id),
  project_id    UUID,
  score         NUMERIC(4,3) NOT NULL CHECK (score BETWEEN 0 AND 1),
  reason_codes  TEXT[] NOT NULL,
  queued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  picked_at     TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  outcome       TEXT
                CHECK (outcome IS NULL OR outcome IN
                       ('interpreted', 'no_action', 'budget_exhausted',
                        'extractor_error'))
);

COMMENT ON TABLE investigation_queue IS
  'Scored deferred work for the investigation_scorer/interpreter chain. '
  'High-score facts (>= investigation.score_threshold_sync) bypass the '
  'queue; low-score facts land here for the periodic sweep.';

CREATE INDEX IF NOT EXISTS idx_investigation_queue_pending
  ON investigation_queue (score DESC) WHERE picked_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────
-- RLS — project-scoped data. SELECT gated on user_project_access
-- (mirrors facts_project_visibility in 62_facts_table.sql; NULL
-- project_id is treated as org-wide / shared). Writes happen as
-- chemclaw_service (BYPASSRLS) via the explicit policy below;
-- chemclaw_app has no write policy → cannot INSERT/UPDATE/DELETE.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE investigation_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE investigation_queue FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS investigation_queue_project_visibility ON investigation_queue;
CREATE POLICY investigation_queue_project_visibility ON investigation_queue
  FOR SELECT
  USING (
    project_id IS NULL
    OR EXISTS (
      SELECT 1 FROM user_project_access upa
       WHERE upa.nce_project_id = investigation_queue.project_id
         AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

DROP POLICY IF EXISTS investigation_queue_service_write ON investigation_queue;
CREATE POLICY investigation_queue_service_write ON investigation_queue
  FOR ALL
  TO chemclaw_service
  USING (true) WITH CHECK (true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT ON investigation_queue TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON investigation_queue TO chemclaw_service;
  END IF;
END $$;

INSERT INTO schema_version (filename, applied_at)
VALUES ('64_investigation_queue.sql', NOW())
ON CONFLICT (filename) DO NOTHING;

COMMIT;
