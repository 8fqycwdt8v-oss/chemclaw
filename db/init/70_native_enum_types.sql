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
--   - CHECK constraints on the affected columns are DROPPED before conversion:
--     PostgreSQL stores constraint expressions with types resolved at creation
--     time, so after the column type changes to ENUM the stored CHECK would
--     compare `maturity_tier = text` — no such operator. ENUM enforces the
--     same invariant, so the CHECK is not re-added.
--   - Views (hypotheses_current, artifacts_current) that SELECT * from tables
--     with maturity columns are DROPPED before conversion and RECREATED after,
--     since PostgreSQL refuses to ALTER a column used by a view.

BEGIN;

-- ── 1. maturity_tier (EXPLORATORY | WORKING | FOUNDATION) ─────────────────

DO $$
BEGIN
  CREATE TYPE maturity_tier AS ENUM ('EXPLORATORY', 'WORKING', 'FOUNDATION');
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
DECLARE
  tbl TEXT;
  rec RECORD;
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
  -- Drop views that SELECT * from maturity-bearing tables; they block ALTER
  -- COLUMN TYPE. Recreated below after all columns are converted.
  DROP VIEW IF EXISTS hypotheses_current CASCADE;
  DROP VIEW IF EXISTS artifacts_current   CASCADE;

  FOREACH tbl IN ARRAY maturity_tables LOOP
    IF EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = tbl
         AND column_name  = 'maturity'
         AND udt_name     = 'text'
    ) THEN
      -- Drop any CHECK constraints referencing maturity. PostgreSQL stores
      -- the literal values as text; after the column type changes to ENUM,
      -- the stored CHECK tries maturity_tier = text — no operator exists.
      FOR rec IN
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_class     cls ON con.conrelid = cls.oid
          JOIN pg_attribute att ON att.attrelid  = cls.oid
                                AND att.attnum   = ANY(con.conkey)
         WHERE cls.relname        = tbl
           AND cls.relnamespace   = 'public'::regnamespace
           AND con.contype        = 'c'
           AND att.attname        = 'maturity'
      LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, rec.conname);
      END LOOP;

      -- Drop DEFAULT first: PostgreSQL cannot auto-cast a stored text default
      -- ('EXPLORATORY') to the new ENUM type. Restore it after the retype.
      EXECUTE format(
        'ALTER TABLE %I '
        'ALTER COLUMN maturity DROP DEFAULT, '
        'ALTER COLUMN maturity TYPE maturity_tier USING maturity::maturity_tier, '
        'ALTER COLUMN maturity SET DEFAULT ''EXPLORATORY''::maturity_tier',
        tbl
      );
    END IF;
  END LOOP;

  -- Recreate hypotheses_current (same definition as 52_bitemporal_current_views.sql).
  IF to_regclass('public.hypotheses') IS NOT NULL THEN
    EXECUTE '
      CREATE OR REPLACE VIEW hypotheses_current
        WITH (security_invoker = true) AS
        SELECT *
          FROM hypotheses
         WHERE refuted_at IS NULL
           AND valid_to   IS NULL
    ';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
      EXECUTE 'GRANT SELECT ON hypotheses_current TO chemclaw_app';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
      EXECUTE 'GRANT SELECT ON hypotheses_current TO chemclaw_service';
    END IF;
  END IF;

  -- Recreate artifacts_current (same definition as 52_bitemporal_current_views.sql).
  IF to_regclass('public.artifacts') IS NOT NULL THEN
    EXECUTE '
      CREATE OR REPLACE VIEW artifacts_current
        WITH (security_invoker = true) AS
        SELECT *
          FROM artifacts
         WHERE superseded_at IS NULL
    ';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
      EXECUTE 'GRANT SELECT ON artifacts_current TO chemclaw_app';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
      EXECUTE 'GRANT SELECT ON artifacts_current TO chemclaw_service';
    END IF;
  END IF;
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
DECLARE
  rec RECORD;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'permission_policies'
       AND column_name  = 'decision'
       AND udt_name     = 'text'
  ) THEN
    FOR rec IN
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class     cls ON con.conrelid = cls.oid
        JOIN pg_attribute att ON att.attrelid  = cls.oid
                              AND att.attnum   = ANY(con.conkey)
       WHERE cls.relname      = 'permission_policies'
         AND cls.relnamespace = 'public'::regnamespace
         AND con.contype      = 'c'
         AND att.attname      = 'decision'
    LOOP
      EXECUTE format('ALTER TABLE permission_policies DROP CONSTRAINT %I', rec.conname);
    END LOOP;

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
DECLARE
  rec RECORD;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'admin_roles'
       AND column_name  = 'role'
       AND udt_name     = 'text'
  ) THEN
    FOR rec IN
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class     cls ON con.conrelid = cls.oid
        JOIN pg_attribute att ON att.attrelid  = cls.oid
                              AND att.attnum   = ANY(con.conkey)
       WHERE cls.relname      = 'admin_roles'
         AND cls.relnamespace = 'public'::regnamespace
         AND con.contype      = 'c'
         AND att.attname      = 'role'
    LOOP
      EXECUTE format('ALTER TABLE admin_roles DROP CONSTRAINT %I', rec.conname);
    END LOOP;

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
