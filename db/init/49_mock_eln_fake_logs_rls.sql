-- Defense-in-depth FORCE ROW LEVEL SECURITY on mock_eln and fake_logs.
--
-- These schemas are test/fixture-only — mock_eln seeds ~2000 deterministic
-- experiments (db/init/30_mock_eln_schema.sql), fake_logs seeds ~3000
-- HPLC/NMR/MS datasets cross-linked to mock_eln.samples
-- (db/init/31_fake_logs_schema.sql). Both grant SELECT to a dedicated
-- NOBYPASSRLS role `chemclaw_mock_eln_reader` consumed only by the
-- mcp_eln_local / mcp_logs_sciy services. chemclaw_app (the user-facing
-- role) is NOT granted access today.
--
-- Without ENABLE / FORCE RLS, a future GRANT SELECT to any other role
-- would silently expose these tables. Every other project-scoped schema
-- in the codebase is FORCE-RLS, so the missing policies on these two
-- schemas is a posture inconsistency. Add a minimal allow-known-roles
-- policy that maintains today's behaviour while ensuring any role added
-- in the future hits the FORCE RLS gate by default.
--
-- The policy uses `current_user` (the connected DB role) rather than
-- `app.current_user_entra_id` because mcp_eln_local connects without
-- setting that GUC — the role-based gate is what's load-bearing.

BEGIN;

-- Helper: enable + force RLS, then create a single allow-known-roles
-- policy for SELECT/INSERT/UPDATE/DELETE.  Done via DO block so each
-- table is handled identically without 30+ near-identical statements.
DO $$
DECLARE
  v_schema TEXT;
  v_table  TEXT;
  v_pname  TEXT;
BEGIN
  FOR v_schema, v_table IN
    SELECT n.nspname, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('mock_eln', 'fake_logs')
       AND c.relkind = 'r'  -- regular tables only
     ORDER BY n.nspname, c.relname
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      v_schema, v_table
    );
    EXECUTE format(
      'ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',
      v_schema, v_table
    );

    -- Drop-and-recreate the policy so re-running this init file is
    -- idempotent (CREATE POLICY itself has no IF NOT EXISTS form).
    v_pname := v_schema || '_' || v_table || '_known_roles';
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      v_pname, v_schema, v_table
    );
    EXECUTE format(
      $f$CREATE POLICY %I ON %I.%I
           FOR ALL
           USING (current_user IN ('chemclaw', 'chemclaw_service', 'chemclaw_mock_eln_reader'))
        $f$,
      v_pname, v_schema, v_table
    );
  END LOOP;
END
$$;

INSERT INTO schema_version (filename)
VALUES ('49_mock_eln_fake_logs_rls.sql')
ON CONFLICT DO NOTHING;

COMMIT;
