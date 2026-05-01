-- Phase 1 of the configuration concept (Initiatives 2 + 10).
--
-- Adds two tables and one helper function that together replace the binary
-- AGENT_ADMIN_USERS env-var check with a real DB-backed RBAC + audit trail:
--
--   admin_roles       — (user_entra_id, role, scope_id) — who is allowed
--                       to call each /api/admin/* endpoint.
--   admin_audit_log   — append-only record of every admin mutation. The
--                       endpoint handler writes one row per state change,
--                       capturing actor, target, before/after JSONB.
--   current_user_is_admin(role_check, scope_check)
--                     — SECURITY DEFINER helper used by RLS policies and
--                       by the require-admin middleware. Bypasses RLS on
--                       admin_roles itself so policies don't recurse.
--
-- All changes ADDITIVE; idempotent under re-apply (IF NOT EXISTS / DROP IF
-- EXISTS guards). Migration is safe to re-run via `make db.init`.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. admin_roles
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_roles (
  user_entra_id TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('global_admin', 'org_admin', 'project_admin')),
  scope_id      TEXT NOT NULL DEFAULT '',         -- empty for global; org_id / project_id otherwise
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by    TEXT NOT NULL,                    -- entra_id of the granter
  PRIMARY KEY (user_entra_id, role, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_roles_user
  ON admin_roles(user_entra_id);

CREATE INDEX IF NOT EXISTS idx_admin_roles_role_scope
  ON admin_roles(role, scope_id);

COMMENT ON TABLE admin_roles IS
  'Phase 1 of the config concept. Replaces the AGENT_ADMIN_USERS env var '
  'check in services/agent-claw/src/routes/forged-tools.ts:isAdmin. '
  'role + scope_id together define what the holder can administer; e.g. '
  '(role=org_admin, scope_id="acme") grants admin over org acme only.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. admin_audit_log
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor        TEXT NOT NULL,                     -- entra_id of the caller
  action       TEXT NOT NULL,                     -- e.g. 'admin_role.grant', 'config.set'
  target       TEXT NOT NULL,                     -- resource id (user entra_id, key name, …)
  before_value JSONB,                             -- NULL for creates
  after_value  JSONB,                             -- NULL for deletes
  reason       TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_actor_time
  ON admin_audit_log(actor, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action_time
  ON admin_audit_log(action, occurred_at DESC);

COMMENT ON TABLE admin_audit_log IS
  'Append-only audit trail for /api/admin/* mutations. INSERT-only from '
  'chemclaw_app via RLS; SELECT only when current_user_is_admin().';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. SECURITY DEFINER helper used by RLS + middleware
--
-- Runs as the function owner (chemclaw, the migration owner) so it can
-- read admin_roles regardless of the caller's RLS context. Without this,
-- an RLS policy on admin_roles that referenced admin_roles itself would
-- recurse and either error or quietly read the unfiltered set.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION current_user_is_admin(
  role_check  TEXT DEFAULT NULL,    -- NULL → any role grants admin
  scope_check TEXT DEFAULT NULL     -- NULL → any scope; otherwise must match exactly OR be global
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin_roles
     WHERE user_entra_id = current_setting('app.current_user_entra_id', true)
       AND (role_check  IS NULL OR role     = role_check)
       AND (scope_check IS NULL OR scope_id = scope_check OR scope_id = '')
  );
$$;

REVOKE ALL ON FUNCTION current_user_is_admin(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_user_is_admin(TEXT, TEXT) TO chemclaw_app, chemclaw_service;

COMMENT ON FUNCTION current_user_is_admin(TEXT, TEXT) IS
  'Returns true when the calling app.current_user_entra_id holds the named '
  'role (or any role when role_check IS NULL). scope_id="" rows count as '
  'global grants and pass any scope_check.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4. RLS on admin_roles
--   - Self-read: every authenticated user can see their OWN roles (so the
--     middleware can answer "am I an admin?" without being one already).
--   - Admin-read/write: global_admins can see and modify everything.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE admin_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_roles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_roles_self_select ON admin_roles;
CREATE POLICY admin_roles_self_select ON admin_roles
  FOR SELECT
  USING (user_entra_id = current_setting('app.current_user_entra_id', true));

DROP POLICY IF EXISTS admin_roles_global_admin_all ON admin_roles;
CREATE POLICY admin_roles_global_admin_all ON admin_roles
  FOR ALL
  USING (current_user_is_admin('global_admin'))
  WITH CHECK (current_user_is_admin('global_admin'));

-- ────────────────────────────────────────────────────────────────────────────
-- 5. RLS on admin_audit_log
--   - Any authenticated user can INSERT (their handler stamps actor=self).
--   - Only admins can SELECT.
--   - Nobody can UPDATE/DELETE — append-only by construction.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_audit_log_insert ON admin_audit_log;
CREATE POLICY admin_audit_log_insert ON admin_audit_log
  FOR INSERT
  WITH CHECK (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
    AND actor = current_setting('app.current_user_entra_id', true)
  );

DROP POLICY IF EXISTS admin_audit_log_admin_select ON admin_audit_log;
CREATE POLICY admin_audit_log_admin_select ON admin_audit_log
  FOR SELECT
  USING (current_user_is_admin());

-- No UPDATE / DELETE policies → both denied for chemclaw_app even with FORCE
-- RLS. chemclaw_service (BYPASSRLS) can still hard-delete for tests / GDPR.

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Bootstrap: promote any AGENT_ADMIN_USERS-listed user to global_admin
--    on first apply. The setting is propagated by db/init's wrapper script
--    when present; otherwise this DO block is a no-op.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_raw TEXT := coalesce(current_setting('chemclaw.bootstrap_admins', true), '');
  v_id  TEXT;
BEGIN
  FOR v_id IN
    SELECT trim(unnest(string_to_array(v_raw, ',')))
  LOOP
    IF v_id <> '' THEN
      INSERT INTO admin_roles (user_entra_id, role, scope_id, granted_by)
        VALUES (lower(v_id), 'global_admin', '', 'bootstrap:18_admin_roles_and_audit.sql')
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;

COMMIT;
