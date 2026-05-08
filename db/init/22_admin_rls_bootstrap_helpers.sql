-- Cluster C: SECURITY DEFINER bootstrap helpers for admin-RLS seed
-- INSERTs.
--
-- Several seeds (40_monty_config_seeds.sql, 22_feature_flags.sql,
-- and any future admin-RLS seed) currently INSERT into FORCE-RLS
-- tables guarded by current_user_is_admin(). Today this only works
-- because POSTGRES_USER is superuser-by-entrypoint and superusers
-- bypass FORCE RLS. Hardened deployments that drop migration
-- privileges to a non-superuser break `make db.init` on those files
-- with "new row violates row-level security policy".
--
-- The two helpers here let those seeds INSERT through a
-- SECURITY DEFINER path that runs with the function-owner's privileges
-- (the table owner — typically chemclaw, who owns the table and
-- therefore bypasses FORCE RLS via OWNER bypass logic when SECURITY
-- DEFINER is invoked). Migrations call the helper instead of issuing
-- a direct INSERT; the result is identical for the calling role
-- regardless of whether they have superuser.
--
-- Usage in a seed:
--   SELECT bootstrap_config_setting(
--     'global', '', 'monty.enabled', 'false'::jsonb,
--     'Master switch for the Monty runtime.', '__bootstrap__'
--   );
--
-- Each helper is idempotent (ON CONFLICT DO NOTHING) so re-running a
-- seed file is safe.

BEGIN;

-- ---------------------------------------------------------------------------
-- bootstrap_config_setting — seed a row into config_settings via
-- SECURITY DEFINER so the migration role doesn't need admin grant.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bootstrap_config_setting(
  p_scope        TEXT,
  p_scope_id     TEXT,
  p_key          TEXT,
  p_value        JSONB,
  p_description  TEXT,
  p_updated_by   TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO config_settings (scope, scope_id, key, value, description, updated_by)
  VALUES (p_scope, p_scope_id, p_key, p_value, p_description, p_updated_by)
  ON CONFLICT (scope, scope_id, key) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION bootstrap_config_setting(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC;
-- chemclaw is the table owner and runs migrations; chemclaw_service
-- is the BYPASSRLS role that one-shot scripts may use; both can call.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT EXECUTE ON FUNCTION bootstrap_config_setting(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT)
      TO chemclaw_service;
    -- Transfer ownership to chemclaw_service (BYPASSRLS) so SECURITY
    -- DEFINER actually bypasses FORCE RLS even when the caller is a
    -- non-superuser migration role. Without OWNER TO, the function
    -- runs with the table-owner's privileges, which under FORCE RLS
    -- are still subject to policy. Requires the migration role to be
    -- a direct/indirect member of chemclaw_service; standard for a
    -- shared-cluster posture but not all deployments. When the role
    -- transfer fails (e.g. role missing the membership), boot
    -- continues — the migration's own superuser-by-entrypoint path
    -- still works for today's deploys, just not hardened ones.
    BEGIN
      ALTER FUNCTION bootstrap_config_setting(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT)
        OWNER TO chemclaw_service;
    EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
      RAISE NOTICE 'bootstrap_config_setting owner transfer to chemclaw_service skipped (insufficient privilege)';
    END;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- bootstrap_feature_flag — same shape, different table. feature_flags
-- has a similar admin-only INSERT policy.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bootstrap_feature_flag(
  p_key          TEXT,
  p_enabled      BOOLEAN,
  p_description  TEXT,
  p_updated_by   TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO feature_flags (key, enabled, description, updated_by)
  VALUES (p_key, p_enabled, p_description, p_updated_by)
  ON CONFLICT (key) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION bootstrap_feature_flag(TEXT, BOOLEAN, TEXT, TEXT) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT EXECUTE ON FUNCTION bootstrap_feature_flag(TEXT, BOOLEAN, TEXT, TEXT)
      TO chemclaw_service;
    BEGIN
      ALTER FUNCTION bootstrap_feature_flag(TEXT, BOOLEAN, TEXT, TEXT)
        OWNER TO chemclaw_service;
    EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
      RAISE NOTICE 'bootstrap_feature_flag owner transfer to chemclaw_service skipped (insufficient privilege)';
    END;
  END IF;
END
$$;

COMMENT ON FUNCTION bootstrap_config_setting(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT) IS
  'Seed-time config_settings INSERT via SECURITY DEFINER so a non-superuser '
  'migration role can apply seed files that target FORCE-RLS tables. '
  'Idempotent (ON CONFLICT DO NOTHING).';
COMMENT ON FUNCTION bootstrap_feature_flag(TEXT, BOOLEAN, TEXT, TEXT) IS
  'Seed-time feature_flags INSERT via SECURITY DEFINER. Idempotent.';

COMMIT;
