-- Phase C.4: maturity tiers.
-- Adds maturity columns to artifact tables and creates the new `artifacts` table.
-- Re-applicable: IF NOT EXISTS / IF COLUMN NOT EXISTS everywhere.

BEGIN;

-- ── Existing tables: add maturity column ─────────────────────────────────────

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS maturity TEXT NOT NULL DEFAULT 'EXPLORATORY'
    CHECK (maturity IN ('EXPLORATORY','WORKING','FOUNDATION'));

ALTER TABLE research_reports
  ADD COLUMN IF NOT EXISTS maturity TEXT NOT NULL DEFAULT 'EXPLORATORY'
    CHECK (maturity IN ('EXPLORATORY','WORKING','FOUNDATION'));

ALTER TABLE hypotheses
  ADD COLUMN IF NOT EXISTS maturity TEXT NOT NULL DEFAULT 'EXPLORATORY'
    CHECK (maturity IN ('EXPLORATORY','WORKING','FOUNDATION'));

-- ── New artifacts table ───────────────────────────────────────────────────────
-- Catch-all for sub-agent results, forged-tool candidates, and any structured
-- tool output that the tag-maturity hook persists.

CREATE TABLE IF NOT EXISTS artifacts (
  id                     uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind                   text        NOT NULL,              -- e.g. 'hypothesis_output', 'sub_agent_result', 'citation_list'
  payload                jsonb       NOT NULL,              -- the raw tool output
  owner_entra_id         text        NOT NULL,
  maturity               text        NOT NULL DEFAULT 'EXPLORATORY'
                                     CHECK (maturity IN ('EXPLORATORY','WORKING','FOUNDATION')),
  confidence_ensemble    jsonb,                             -- ConfidenceEnsemble shape; NULL until computed
  agent_trace_id         text,                             -- chat trace that produced this artifact
  tool_id                text,                             -- which tool produced it
  created_at             timestamptz NOT NULL DEFAULT NOW(),
  updated_at             timestamptz NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_artifacts_updated_at ON artifacts;
CREATE TRIGGER trg_artifacts_updated_at
  BEFORE UPDATE ON artifacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_artifacts_owner
  ON artifacts(owner_entra_id);

CREATE INDEX IF NOT EXISTS idx_artifacts_maturity
  ON artifacts(maturity);

CREATE INDEX IF NOT EXISTS idx_artifacts_kind
  ON artifacts(kind);

CREATE INDEX IF NOT EXISTS idx_artifacts_trace
  ON artifacts(agent_trace_id)
  WHERE agent_trace_id IS NOT NULL;

ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;

-- Owner sees their own artifacts; scope widening (shared team artifacts) is Phase F.
DROP POLICY IF EXISTS artifacts_owner_select ON artifacts;
CREATE POLICY artifacts_owner_select ON artifacts FOR SELECT
  USING (owner_entra_id = current_setting('app.current_user_entra_id', true));

DROP POLICY IF EXISTS artifacts_owner_insert ON artifacts;
CREATE POLICY artifacts_owner_insert ON artifacts FOR INSERT
  WITH CHECK (owner_entra_id = current_setting('app.current_user_entra_id', true));

DROP POLICY IF EXISTS artifacts_owner_update ON artifacts;
CREATE POLICY artifacts_owner_update ON artifacts FOR UPDATE
  USING (owner_entra_id = current_setting('app.current_user_entra_id', true))
  WITH CHECK (owner_entra_id = current_setting('app.current_user_entra_id', true));

COMMIT;
