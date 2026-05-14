-- Track D (cross-project KG transfer plan, docs/research/kg-transfer-learning.md):
-- skill_library carries a maturity column (added in 17_unified_confidence_and_temporal.sql)
-- and success/total run counters, but no representation of how many distinct
-- projects have validated a skill. Without that signal, a skill that succeeded
-- 30 times inside a single project's narrow workflow looks identical to one
-- proven across the portfolio — which is exactly the cross-project distinction
-- the optimizer's promotion gate needs.
--
-- This migration adds two columns plus a small SECURITY DEFINER helper to
-- record validations idempotently. The promoter (services/optimizer/skill_promoter/)
-- reads `validated_in_projects` and `evidence_count` and gates on configurable
-- thresholds; defaults are 0 so legacy rows with empty arrays are not blocked.
--
-- Population is intentionally NOT wired in this migration: routes/learn.ts and
-- forge_tool.ts don't currently receive nce_project_id, and skill_library
-- success_count / total_runs are themselves dormant. Both are tracked as
-- BACKLOG follow-ups (see CLAUDE.md "General rules" #5 / BACKLOG.md).

BEGIN;

-- ── Columns ──────────────────────────────────────────────────────────────────

ALTER TABLE skill_library
  ADD COLUMN IF NOT EXISTS validated_in_projects UUID[] NOT NULL DEFAULT '{}';

ALTER TABLE skill_library
  ADD COLUMN IF NOT EXISTS evidence_count INT NOT NULL DEFAULT 0
    CHECK (evidence_count >= 0);

-- The number of distinct projects must never exceed evidence_count.
-- CHECK constraints are evaluated at end-of-statement in PostgreSQL, so
-- the helper's single-statement UPDATE that touches both columns at once
-- never trips the constraint mid-update. (CHECK constraints can't be
-- DEFERRABLE in PG; only UNIQUE / FK / EXCLUDE can.)
ALTER TABLE skill_library
  DROP CONSTRAINT IF EXISTS skill_library_validation_consistency;
ALTER TABLE skill_library
  ADD CONSTRAINT skill_library_validation_consistency
    CHECK (
      array_length(validated_in_projects, 1) IS NULL
      OR array_length(validated_in_projects, 1) <= evidence_count
    );

-- GIN index for "skills validated in project X" queries used by the promoter
-- and any future cross-project skill discovery surface.
CREATE INDEX IF NOT EXISTS idx_skill_library_validated_in_projects
  ON skill_library USING GIN (validated_in_projects);

-- ── Idempotent population helper ─────────────────────────────────────────────
--
-- record_skill_project_validation appends project_id to validated_in_projects
-- iff not already present, and increments evidence_count by 1 unconditionally.
-- The "iff not already present" semantics give us cross-project diversity
-- counting (each project counts once) while preserving raw success volume in
-- evidence_count.
--
-- SECURITY DEFINER + chemclaw_service ownership so callers running as
-- chemclaw_app (subject to FORCE RLS on skill_library) can populate the
-- column without needing the broader UPDATE permission on rows they don't own.
-- The function locks the row by id only, no scan.

CREATE OR REPLACE FUNCTION record_skill_project_validation(
  p_skill_id UUID,
  p_project_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_skill_id IS NULL OR p_project_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE skill_library
     SET validated_in_projects = CASE
           WHEN p_project_id = ANY(validated_in_projects) THEN validated_in_projects
           ELSE array_append(validated_in_projects, p_project_id)
         END,
         evidence_count = evidence_count + 1
   WHERE id = p_skill_id;
END;
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    ALTER FUNCTION record_skill_project_validation(UUID, UUID) OWNER TO chemclaw_service;
  END IF;
END $$;

REVOKE ALL ON FUNCTION record_skill_project_validation(UUID, UUID) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT EXECUTE ON FUNCTION record_skill_project_validation(UUID, UUID) TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT EXECUTE ON FUNCTION record_skill_project_validation(UUID, UUID) TO chemclaw_service;
  END IF;
END $$;
-- Self-record for schema_version (Makefile loop is belt-and-suspenders).
INSERT INTO schema_version (filename, applied_at)
  VALUES ('54_skill_library_validated_projects.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
