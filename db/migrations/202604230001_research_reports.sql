-- research_reports: persisted Deep Research outputs.
-- Idempotent (CREATE TABLE IF NOT EXISTS) so it can be applied by
-- docker-entrypoint-initdb.d on fresh volumes and by `make db.init` on
-- existing ones.

BEGIN;

CREATE TABLE IF NOT EXISTS research_reports (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_entra_id     TEXT NOT NULL,
  query             TEXT NOT NULL,
  markdown          TEXT NOT NULL,
  citations         JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  prompt_version    INT,
  agent_trace_id    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  token_count       INT
);
CREATE INDEX IF NOT EXISTS idx_research_reports_user_created
  ON research_reports (user_entra_id, created_at DESC);

-- RLS: a user can only see their own reports (for MVP). Future: share by
-- project via a separate `research_report_shares` table.
ALTER TABLE research_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS research_reports_owner_policy ON research_reports;
CREATE POLICY research_reports_owner_policy ON research_reports
  FOR SELECT
  USING (
    current_setting('app.current_user_entra_id', true) IS NULL
    OR current_setting('app.current_user_entra_id', true) = ''
    OR user_entra_id = current_setting('app.current_user_entra_id', true)
  );

COMMIT;
