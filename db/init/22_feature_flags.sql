-- Phase 2 of the configuration concept (Initiative 6).
--
-- Single source of truth replacing scattered process.env.X === 'true' gates
-- (AGENT_CONFIDENCE_CROSS_MODEL, MCP_AUTH_DEV_MODE, CHEMCLAW_DEV_MODE,
-- mock-eln gates). Each row carries its own description so
-- GET /api/admin/feature-flags is the catalog.
--
-- Env vars remain as bootstrap defaults; the DB row wins when present.
--
-- scope_rule (JSONB) is optional; when set it gates by org / project. Shape:
--   {"orgs": ["acme", "globex"]}            — flag enabled only for these orgs
--   {"projects": ["proj-1"]}                — only for these projects
--   {"users": ["alice@x.com"]}              — only for these users
-- Multiple keys are AND'd. Absent → enabled value applies globally.

BEGIN;

CREATE TABLE IF NOT EXISTS feature_flags (
  key          TEXT PRIMARY KEY,
  enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  scope_rule   JSONB,
  description  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feature_flags_enabled
  ON feature_flags(enabled);

COMMENT ON TABLE feature_flags IS
  'Phase 2 of the config concept. Replaces scattered env-var feature gates. '
  'Read by services/agent-claw config/flags.ts and services/common/'
  'config_registry.py with a 60s cache. The DB row wins over the env-var '
  'fallback when present.';

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — any authenticated user can SELECT (the feature-flag helper needs
-- to ask "am I enabled?"). Admin-only writes.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_flags FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feature_flags_authn_select ON feature_flags;
CREATE POLICY feature_flags_authn_select ON feature_flags
  FOR SELECT
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  );

DROP POLICY IF EXISTS feature_flags_admin_write ON feature_flags;
CREATE POLICY feature_flags_admin_write ON feature_flags
  FOR ALL
  USING (current_user_is_admin())
  WITH CHECK (current_user_is_admin());

-- ────────────────────────────────────────────────────────────────────────────
-- Seed the catalog with the env-var gates we already have, so admins can
-- discover them via GET /api/admin/feature-flags before any code migration.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO feature_flags (key, enabled, description, updated_by)
VALUES
  ('agent.confidence_cross_model', false,
   'Phase D shadow cross-model agreement signal. Expensive — adds a Haiku '
   'call per turn. Mirrors AGENT_CONFIDENCE_CROSS_MODEL env var.',
   'seed:22_feature_flags.sql'),
  ('mcp.auth_dev_mode', false,
   'Bypasses MCP JWT validation for local dev. NEVER enable in production. '
   'Mirrors MCP_AUTH_DEV_MODE env var.',
   'seed:22_feature_flags.sql'),
  ('chemclaw.dev_mode', false,
   'Top-level dev-mode toggle. Disables several auth checks. '
   'Mirrors CHEMCLAW_DEV_MODE env var.',
   'seed:22_feature_flags.sql'),
  ('mock_eln.enabled', false,
   'Enables the local mock-ELN testbed (mcp_eln_local). '
   'Mirrors MOCK_ELN_ENABLED env var.',
   'seed:22_feature_flags.sql')
ON CONFLICT (key) DO NOTHING;

COMMIT;
