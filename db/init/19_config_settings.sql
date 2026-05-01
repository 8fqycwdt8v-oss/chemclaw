-- Phase 2 of the configuration concept (Initiative 1).
--
-- Generalised scoped key/value store. Replaces ~15 hardcoded constants
-- (MAX_ACTIVE_SKILLS, GEPA promotion thresholds, reanimator stalled-definition
-- knobs, per-role inference params, default per-tenant budgets, etc.) by
-- letting an admin set a row at the right scope and have the change picked
-- up within 60s without a code change or restart.
--
-- Resolution rule: user > project > org > global; first hit wins.
-- A setting unset at every scope falls through to the caller's default,
-- so the migration is non-breaking — it only TAKES EFFECT once a row exists.
--
-- Idempotent under re-apply (IF NOT EXISTS / OR REPLACE / DROP IF EXISTS).

BEGIN;

CREATE TABLE IF NOT EXISTS config_settings (
  scope        TEXT NOT NULL CHECK (scope IN ('global', 'org', 'project', 'user')),
  scope_id     TEXT NOT NULL DEFAULT '',           -- empty for global
  key          TEXT NOT NULL,
  value        JSONB NOT NULL,
  description  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id, key),
  -- A global-scope row must have empty scope_id; scoped rows must NOT.
  CHECK (
    (scope = 'global' AND scope_id = '')
    OR (scope <> 'global' AND scope_id <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_config_settings_key
  ON config_settings(key);

CREATE INDEX IF NOT EXISTS idx_config_settings_updated
  ON config_settings(updated_at DESC);

COMMENT ON TABLE config_settings IS
  'Phase 2 of the config concept. Scoped (global / org / project / user) '
  'key/value store read at runtime by services/agent-claw config/registry.ts '
  'and services/common/config_registry.py with a 60s cache. '
  'See docs/runbooks/config-settings-management.md (Phase 4) for examples.';

-- ────────────────────────────────────────────────────────────────────────────
-- Hot-path resolver
--
-- Inputs are nullable to make the call ergonomic — pass only the scope_ids
-- the caller actually has. The resolver returns the value at the most-specific
-- scope that has a row, or NULL when none exist.
--
-- SECURITY DEFINER so the agent's chemclaw_app pool can call this without
-- an admin-gated SELECT policy on config_settings (admins see / mutate the
-- table directly; everyone else only reads through this function).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION resolve_config_setting(
  k          TEXT,
  user_id    TEXT DEFAULT NULL,
  project_id TEXT DEFAULT NULL,
  org_id     TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT value
    FROM config_settings
   WHERE key = k
     AND (
          (scope = 'user'    AND user_id    IS NOT NULL AND scope_id = user_id)
       OR (scope = 'project' AND project_id IS NOT NULL AND scope_id = project_id)
       OR (scope = 'org'     AND org_id     IS NOT NULL AND scope_id = org_id)
       OR (scope = 'global'  AND scope_id = '')
     )
   ORDER BY CASE scope
              WHEN 'user'    THEN 1
              WHEN 'project' THEN 2
              WHEN 'org'     THEN 3
              WHEN 'global'  THEN 4
            END
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION resolve_config_setting(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_config_setting(TEXT, TEXT, TEXT, TEXT)
  TO chemclaw_app, chemclaw_service;

COMMENT ON FUNCTION resolve_config_setting(TEXT, TEXT, TEXT, TEXT) IS
  'Hot-path config lookup. Returns the most-specific value across user > '
  'project > org > global scopes, or NULL when no row matches. SECURITY '
  'DEFINER so chemclaw_app reads without an admin SELECT policy on the '
  'underlying table.';

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — admin writes; nobody but admins reads the raw table.
--
-- The chemclaw_app pool resolves values via resolve_config_setting() which
-- bypasses RLS by design. The /api/admin/config/* endpoints SELECT directly
-- and rely on the admin policy.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE config_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS config_settings_admin_select ON config_settings;
CREATE POLICY config_settings_admin_select ON config_settings
  FOR SELECT
  USING (current_user_is_admin());

DROP POLICY IF EXISTS config_settings_admin_write ON config_settings;
CREATE POLICY config_settings_admin_write ON config_settings
  FOR ALL
  USING (current_user_is_admin())
  WITH CHECK (current_user_is_admin());

COMMIT;
