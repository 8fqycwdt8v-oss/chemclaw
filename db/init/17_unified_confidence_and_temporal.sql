-- PR-8: Unified confidence model + bi-temporal Postgres columns + missing indexes.
-- Addresses Track C audit findings: §2 (bi-temporal), §3 (confidence),
-- §4 (maturity), §5 (FK indexes), §6 (skill_library DELETE policy).
--
-- All changes are ADDITIVE — no columns dropped, no existing readers broken.
-- Re-applicable: every statement is idempotent.
--
-- Confidence design:
--   reactions.confidence_score  NUMERIC(4,3) — added alongside existing
--     confidence_tier TEXT. Score is backfilled from tier. Tier column stays
--     as mutable TEXT (not converted to GENERATED) to avoid breaking writers.
--   hypotheses already has confidence NUMERIC(4,3) — no change needed there.
--   artifacts: guarded by table existence check.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Bi-temporal columns on reactions
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE reactions
  ADD COLUMN IF NOT EXISTS valid_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_to    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invalidated BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill valid_from from the reaction's created_at for all existing rows.
-- WHERE guard makes this a no-op on re-apply (created_at is fixed at insert).
UPDATE reactions
   SET valid_from = created_at
 WHERE valid_from > created_at + INTERVAL '1 second';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Bi-temporal columns on hypotheses
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE hypotheses
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refuted_at TIMESTAMPTZ;

UPDATE hypotheses
   SET valid_from = created_at
 WHERE valid_from > created_at + INTERVAL '1 second';

-- Backfill refuted_at for rows already in status='refuted'.
UPDATE hypotheses
   SET refuted_at = updated_at
 WHERE status = 'refuted'
   AND refuted_at IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Unified confidence_score on reactions
--    reactions currently has only confidence_tier TEXT (5-value CHECK).
--    We add confidence_score NUMERIC(4,3) backfilled from tier.
--    The existing confidence_tier TEXT column is NOT dropped or altered.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE reactions
  ADD COLUMN IF NOT EXISTS confidence_score NUMERIC(4,3)
    CHECK (confidence_score IS NULL OR
           (confidence_score >= 0.000 AND confidence_score <= 1.000));

UPDATE reactions
   SET confidence_score = CASE confidence_tier
     WHEN 'expert_validated'  THEN 1.000
     WHEN 'multi_source_llm'  THEN 0.850
     WHEN 'single_source_llm' THEN 0.500
     WHEN 'expert_disputed'   THEN 0.300
     WHEN 'invalidated'       THEN 0.000
     ELSE                          0.500
   END
 WHERE confidence_score IS NULL;

-- Make NOT NULL + default after backfill, idempotently.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'reactions'
       AND column_name  = 'confidence_score'
       AND is_nullable  = 'YES'
  ) THEN
    ALTER TABLE reactions
      ALTER COLUMN confidence_score SET NOT NULL,
      ALTER COLUMN confidence_score SET DEFAULT 0.500;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. bi-temporal + confidence on artifacts (table-existence guarded)
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.artifacts') IS NOT NULL THEN
    EXECUTE '
      ALTER TABLE artifacts
        ADD COLUMN IF NOT EXISTS valid_from     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS superseded_at  TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS confidence_score NUMERIC(4,3)
          CHECK (confidence_score IS NULL OR
                 (confidence_score >= 0.000 AND confidence_score <= 1.000))
    ';
    EXECUTE '
      UPDATE artifacts
         SET valid_from = created_at
       WHERE valid_from > created_at + INTERVAL ''1 second''
    ';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. maturity column on skill_library and forged_tool_tests
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.skill_library') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE skill_library
      ADD COLUMN IF NOT EXISTS maturity TEXT NOT NULL DEFAULT ''EXPLORATORY''
        CHECK (maturity IN (''EXPLORATORY'', ''WORKING'', ''FOUNDATION''))';
  END IF;
  IF to_regclass('public.forged_tool_tests') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE forged_tool_tests
      ADD COLUMN IF NOT EXISTS maturity TEXT NOT NULL DEFAULT ''EXPLORATORY''
        CHECK (maturity IN (''EXPLORATORY'', ''WORKING'', ''FOUNDATION''))';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Missing FK indexes — every RLS EXISTS subquery is unindexed without these.
-- ────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_user_project_access_user_project
  ON user_project_access (user_entra_id, nce_project_id);

CREATE INDEX IF NOT EXISTS idx_synthetic_steps_project
  ON synthetic_steps (nce_project_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 7. skill_library DELETE RLS policy (Track C §6 residual)
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.skill_library') IS NOT NULL THEN
    DROP POLICY IF EXISTS skill_library_owner_delete ON skill_library;
    EXECUTE 'CREATE POLICY skill_library_owner_delete ON skill_library FOR DELETE
      USING (
        current_setting(''app.current_user_entra_id'', true) IS NOT NULL
        AND current_setting(''app.current_user_entra_id'', true) <> ''''
        AND proposed_by_user_entra_id = current_setting(''app.current_user_entra_id'', true)
      )';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 8. Grants — new tables and columns inherit chemclaw_service ALL.
--    (16_db_audit_fixes.sql §8 already grants on existing tables; replay here
--    so 17 is self-contained when applied to a partial-schema dev environment.)
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON reactions    TO chemclaw_service;
    GRANT ALL ON hypotheses   TO chemclaw_service;
    IF to_regclass('public.skill_library') IS NOT NULL THEN
      GRANT ALL ON skill_library TO chemclaw_service;
    END IF;
    IF to_regclass('public.artifacts') IS NOT NULL THEN
      GRANT ALL ON artifacts TO chemclaw_service;
    END IF;
  END IF;
END $$;

COMMIT;
