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
--     PostgreSQL stores the constraint with resolved text-type literals, and
--     after the column type changes to ENUM the stored CHECK compares
--     `maturity_tier = text` which has no operator. The ENUM type enforces
--     the same invariant, so the CHECK is not re-added.

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
  FOREACH tbl IN ARRAY maturity_tables LOOP
    IF EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = tbl
         AND column_name  = 'maturity'
         AND udt_name     = 'text'
    ) THEN
      -- Drop any CHECK constraints referencing the maturity column.
      -- PostgreSQL stores CHECK constraint expressions with the literal types
      -- resolved at creation time (text). After converting the column to
      -- maturity_tier, the stored expression compares maturity_tier = text,
      -- which has no operator. The ENUM type enforces the same invariant.
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

      -- Must drop the DEFAULT before retyping: PostgreSQL cannot automatically
      -- cast a stored text default ('EXPLORATORY') to the new ENUM type.
      -- Restore the default after the type change using the ENUM literal.
      EXECUTE format(
        'ALTER TABLE %I '
        'ALTER COLUMN maturity DROP DEFAULT, '
        'ALTER COLUMN maturity TYPE maturity_tier USING maturity::maturity_tier, '
        'ALTER COLUMN maturity SET DEFAULT ''EXPLORATORY''::maturity_tier',
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
