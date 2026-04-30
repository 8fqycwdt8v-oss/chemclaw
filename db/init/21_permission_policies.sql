-- Phase 3 of the configuration concept (Initiative 5).
--
-- DB-backed permission policy table — replaces the no-op permission hook
-- in services/agent-claw/src/core/hooks/permission.ts with rules that an
-- admin can flip via /api/admin/permission-policies without a code change.
--
-- Decision is one of allow / deny / ask; the lifecycle's deny>defer>ask>allow
-- aggregator means a deny at any scope wins. The agent's resolver short-
-- circuits the pre_tool dispatch on a deny.
--
-- tool_pattern is a glob: exact match, or trailing wildcard (e.g.
-- 'mcp__github__*'). The application-side reader handles the matching;
-- the table just stores the strings.
--
-- argument_pattern (optional) is a regex applied to the JSON-stringified
-- tool args, supporting policies like "deny Bash if it contains rm -rf".
-- Bound length 200, same safety rationale as redaction_patterns.

BEGIN;

CREATE TABLE IF NOT EXISTS permission_policies (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            TEXT NOT NULL CHECK (scope IN ('global', 'org', 'project')),
  scope_id         TEXT NOT NULL DEFAULT '',
  decision         TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'ask')),
  tool_pattern     TEXT NOT NULL,            -- 'Write', 'mcp__github__*', etc.
  argument_pattern TEXT,                     -- optional regex against JSON.stringify(input)
  reason           TEXT,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       TEXT NOT NULL,
  CHECK (length(tool_pattern) <= 200),
  CHECK (argument_pattern IS NULL OR length(argument_pattern) <= 200),
  CHECK (
    (scope = 'global' AND scope_id = '')
    OR (scope <> 'global' AND scope_id <> '')
  )
);

-- Disambiguating "same rule registered twice at the same scope" must surface
-- as a 409 from the admin endpoint, not a silent NOOP — the unique index
-- pins the natural identity of a policy row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_permission_policies_natural_key
  ON permission_policies(scope, scope_id, decision, tool_pattern, COALESCE(argument_pattern, ''));

CREATE INDEX IF NOT EXISTS idx_permission_policies_scope_enabled
  ON permission_policies(scope, scope_id, enabled);

CREATE INDEX IF NOT EXISTS idx_permission_policies_decision
  ON permission_policies(decision)
  WHERE enabled = TRUE;

COMMENT ON TABLE permission_policies IS
  'Phase 3 of the config concept. Read by services/agent-claw/src/core/'
  'hooks/permission.ts with a 60s cache. Aggregator rule (deny>defer>ask>'
  'allow) means a deny at any scope wins.';

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — admin-only writes; SELECT for any authenticated user so the
-- in-process permission hook can read the rule set under chemclaw_app.
-- Rows describe what is gated, not what the gate guards, so they are
-- not secret.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE permission_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS permission_policies_authn_select ON permission_policies;
CREATE POLICY permission_policies_authn_select ON permission_policies
  FOR SELECT
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  );

DROP POLICY IF EXISTS permission_policies_admin_write ON permission_policies;
CREATE POLICY permission_policies_admin_write ON permission_policies
  FOR ALL
  USING (current_user_is_admin())
  WITH CHECK (current_user_is_admin());

COMMIT;
