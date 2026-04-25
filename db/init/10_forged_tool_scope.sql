-- Phase D.5: forged tool scope, cross-project sharing, persistent test cases,
--             nightly validation runs.
-- Idempotent: all changes use IF NOT EXISTS / DROP IF EXISTS / DO $$ blocks.

BEGIN;

-- ============================================================
-- 1. Extend skill_library with scope + provenance columns
-- ============================================================

ALTER TABLE skill_library
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'private'
    CHECK (scope IN ('private', 'project', 'org')),
  ADD COLUMN IF NOT EXISTS forged_by_model TEXT,
  ADD COLUMN IF NOT EXISTS forged_by_role TEXT
    CHECK (forged_by_role IN ('planner', 'executor', 'compactor', 'judge')
           OR forged_by_role IS NULL),
  ADD COLUMN IF NOT EXISTS parent_tool_id UUID REFERENCES skill_library(id),
  ADD COLUMN IF NOT EXISTS scope_promoted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scope_promoted_by TEXT;

-- ============================================================
-- 2. Replace SELECT RLS policy with scope-aware one
-- ============================================================

-- Drop the old owner-or-active-global policy from 06_skill_library.sql.
DROP POLICY IF EXISTS skill_library_owner_or_active_global ON skill_library;
DROP POLICY IF EXISTS skill_library_visibility ON skill_library;

CREATE POLICY skill_library_visibility ON skill_library FOR SELECT USING (
  -- Caller owns the row.
  proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true)
  -- Or it's org-scoped and active.
  OR (scope = 'org' AND active = true)
  -- Or it's project-scoped, active, and the proposer shares a project with the caller.
  OR (scope = 'project' AND active = true AND EXISTS (
    SELECT 1 FROM user_project_access upa
    WHERE upa.user_entra_id = current_setting('app.current_user_entra_id', true)
      AND EXISTS (
        SELECT 1 FROM user_project_access upa2
        WHERE upa2.user_entra_id = skill_library.proposed_by_user_entra_id
          AND upa2.nce_project_id = upa.nce_project_id
      )
  ))
);

-- ============================================================
-- 3. Persistent test cases table
-- ============================================================

CREATE TABLE IF NOT EXISTS forged_tool_tests (
  id                   UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  forged_tool_id       UUID        NOT NULL REFERENCES skill_library(id) ON DELETE CASCADE,
  input_json           JSONB       NOT NULL,
  expected_output_json JSONB       NOT NULL,
  tolerance_json       JSONB,                      -- optional per-field tolerances
  kind                 TEXT        NOT NULL DEFAULT 'functional'
                                   CHECK (kind IN ('functional', 'contract', 'property')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forged_tool_tests_tool
  ON forged_tool_tests(forged_tool_id);

ALTER TABLE forged_tool_tests ENABLE ROW LEVEL SECURITY;

-- Owner or any user who can see the tool can also see its tests.
DROP POLICY IF EXISTS forged_tool_tests_visibility ON forged_tool_tests;
CREATE POLICY forged_tool_tests_visibility ON forged_tool_tests FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM skill_library sl
    WHERE sl.id = forged_tool_tests.forged_tool_id
  )
);

DROP POLICY IF EXISTS forged_tool_tests_owner_insert ON forged_tool_tests;
CREATE POLICY forged_tool_tests_owner_insert ON forged_tool_tests FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM skill_library sl
      WHERE sl.id = forged_tool_tests.forged_tool_id
        AND sl.proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

-- ============================================================
-- 4. Nightly validation run history
-- ============================================================

CREATE TABLE IF NOT EXISTS forged_tool_validation_runs (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  forged_tool_id  UUID        NOT NULL REFERENCES skill_library(id) ON DELETE CASCADE,
  run_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_tests     INT         NOT NULL DEFAULT 0,
  passed          INT         NOT NULL DEFAULT 0,
  failed          INT         NOT NULL DEFAULT 0,
  status          TEXT        NOT NULL
                              CHECK (status IN ('passing', 'degraded', 'failing')),
  errors_json     JSONB
);

CREATE INDEX IF NOT EXISTS idx_validation_runs_tool
  ON forged_tool_validation_runs(forged_tool_id, run_at DESC);

ALTER TABLE forged_tool_validation_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS validation_runs_visibility ON forged_tool_validation_runs;
CREATE POLICY validation_runs_visibility ON forged_tool_validation_runs FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM skill_library sl
    WHERE sl.id = forged_tool_validation_runs.forged_tool_id
  )
);

-- Validator service inserts via service role (BYPASSRLS).
-- Insert policy for regular users not needed; validator runs as chemclaw_service.

COMMIT;
