-- Tranche 8: Replace closed-value-set CHECK constraints with native PostgreSQL
-- ENUM types. Applies only to value sets that are truly closed — not
-- hypothetical future expansion candidates.
--
-- Three ENUM types created:
--   maturity_tier     — 7 tables: documents, research_reports, hypotheses,
--                        artifacts, skill_library, forged_tool_tests,
--                        knowledge_articles
--   permission_decision — permission_policies.decision (allow | deny | ask)
--   admin_role_kind   — admin_roles.role
--
-- Idempotent:
--   - ENUM creation wrapped in EXCEPTION WHEN duplicate_object.
--   - Column conversion guarded by information_schema.columns udt_name check;
--     skipped when the column is already the target ENUM type.
--   - Existing CHECK constraints on these columns become redundant after
--     conversion (the ENUM already enforces the same invariant) but are left
--     in place — they cause no errors and would require named DROPs to remove.

BEGIN;

-- ── 1. maturity_tier (EXPLORATORY | WORKING | FOUNDATION) ─────────────────
-- Shared across 7 tables; converting to a named type makes ADD VALUE the
-- single change point if a new tier is ever approved.

DO $$
BEGIN
  CREATE TYPE maturity_tier AS ENUM ('EXPLORATORY', 'WORKING', 'FOUNDATION');
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
DECLARE
  tbl TEXT;
  maturity_tables TEXT[] := ARRAY[
    'documents',
    'research_reports',
    'hypotheses',
    'artifacts',
    'skill_library',
    'forged_tool_tests',
    'knowledge_articles'
  ];
BEGIN
  FOREACH tbl IN ARRAY maturity_tables LOOP
    IF EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = tbl
         AND column_name  = 'maturity'
         AND udt_name     = 'text'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN maturity TYPE maturity_tier '
        'USING maturity::maturity_tier',
        tbl
      );
    END IF;
  END LOOP;
END;
$$;

-- ── 2. permission_decision (allow | deny | ask) ────────────────────────────

DO $$
BEGIN
  CREATE TYPE permission_decision AS ENUM ('allow', 'deny', 'ask');
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'permission_policies'
       AND column_name  = 'decision'
       AND udt_name     = 'text'
  ) THEN
    ALTER TABLE permission_policies
      ALTER COLUMN decision TYPE permission_decision
      USING decision::permission_decision;
  END IF;
END;
$$;

-- ── 3. admin_role_kind (global_admin | org_admin | project_admin) ──────────

DO $$
BEGIN
  CREATE TYPE admin_role_kind AS ENUM ('global_admin', 'org_admin', 'project_admin');
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'admin_roles'
       AND column_name  = 'role'
       AND udt_name     = 'text'
  ) THEN
    ALTER TABLE admin_roles
      ALTER COLUMN role TYPE admin_role_kind
      USING role::admin_role_kind;
  END IF;
END;
$$;

-- Self-record (Makefile loop is belt-and-suspenders).
INSERT INTO schema_version (filename)
VALUES ('70_native_enum_types.sql')
ON CONFLICT DO NOTHING;

COMMIT;
