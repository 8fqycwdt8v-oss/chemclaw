-- Phase 3 of the configuration concept (Initiative 4).
--
-- Replaces the hardcoded regex patterns in services/litellm_redactor/
-- redaction.py with a DB-backed registry so an admin (org admin onboarding
-- a new tenant with a different compound-code format) can `INSERT` a row
-- and have it picked up within 60s without redeploying.
--
-- Patterns are scope='global' OR scope='org' (the redactor runs in the
-- LiteLLM gateway where per-user/per-project context isn't natively
-- available; org-level scoping is the smallest meaningful tenant tier).
--
-- Safety rails:
--   - length(pattern_regex) <= 200 — bounded complexity (matches the
--     audit notes in CLAUDE.md about avoiding catastrophic backtracking)
--   - category enumerated to small known set so dashboards stay sane
--   - the application-side loader must `re.compile()` each pattern AND
--     reject patterns that contain unbounded `.*` / `.+` constructs.
--     The DB CHECK can't catch every pathological regex; the loader is
--     the second line of defence.

BEGIN;

CREATE TABLE IF NOT EXISTS redaction_patterns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           TEXT NOT NULL CHECK (scope IN ('global', 'org')),
  scope_id        TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL CHECK (category IN (
                    'SMILES', 'RXN_SMILES', 'EMAIL', 'NCE',
                    'CMP', 'COMPOUND_CODE', 'PROJECT_ID', 'CUSTOM'
                  )),
  pattern_regex   TEXT NOT NULL,
  flags_re_i      BOOLEAN NOT NULL DEFAULT FALSE,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT NOT NULL,
  description     TEXT,
  CHECK (length(pattern_regex) <= 200),
  CHECK (
    (scope = 'global' AND scope_id = '')
    OR (scope = 'org' AND scope_id <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_redaction_patterns_scope_enabled
  ON redaction_patterns(scope, scope_id, enabled);

CREATE INDEX IF NOT EXISTS idx_redaction_patterns_category
  ON redaction_patterns(category);

COMMENT ON TABLE redaction_patterns IS
  'Phase 3 of the config concept. Read by services/litellm_redactor/'
  'redaction.py with a 60s cache. The hardcoded patterns in that file '
  'remain as a baseline; DB rows are MERGED with them rather than replacing.';

-- ────────────────────────────────────────────────────────────────────────────
-- Seed the existing five hardcoded patterns as scope='global' rows so
-- admins can SEE them in /api/admin/redaction-patterns and toggle each off
-- if needed (e.g., to drop NCE redaction for a non-pharma tenant).
--
-- Marking enabled=true keeps current behaviour intact; the redactor still
-- applies its compiled-in patterns AND these rows AND any tenant org rows.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO redaction_patterns
  (scope, scope_id, category, pattern_regex, flags_re_i, enabled, created_by, description)
VALUES
  ('global', '', 'SMILES',
   '(?<![A-Za-z0-9])[A-Za-z0-9@+\-\[\]\(\)=#/\\\.]{6,200}(?![A-Za-z0-9])',
   false, true,
   'seed:20_redaction_patterns.sql',
   'SMILES heuristic — bounded char class with word boundaries.'),
  ('global', '', 'RXN_SMILES',
   '\S{1,400}>\S{0,400}>\S{1,400}',
   false, true,
   'seed:20_redaction_patterns.sql',
   'Reaction SMILES — two arrow separators.'),
  ('global', '', 'EMAIL',
   '[a-zA-Z0-9_.+\-]{1,64}@[a-zA-Z0-9\-]{1,253}\.[a-zA-Z0-9\-.]{2,63}',
   false, true,
   'seed:20_redaction_patterns.sql',
   'Email — Entra IDs, operators.'),
  ('global', '', 'NCE',
   '\bNCE-\d{1,6}\b',
   true, true,
   'seed:20_redaction_patterns.sql',
   'NCE project identifier.'),
  ('global', '', 'CMP',
   '\bCMP-\d{4,8}\b',
   true, true,
   'seed:20_redaction_patterns.sql',
   'Internal compound code (default prefix).')
ON CONFLICT DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — admin-only writes; SELECT for any authenticated user so the
-- gateway's redactor can read the catalog. Rows are public-by-design
-- (the patterns themselves aren't secret; what they protect is).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE redaction_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE redaction_patterns FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS redaction_patterns_authn_select ON redaction_patterns;
CREATE POLICY redaction_patterns_authn_select ON redaction_patterns
  FOR SELECT
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  );

DROP POLICY IF EXISTS redaction_patterns_admin_write ON redaction_patterns;
CREATE POLICY redaction_patterns_admin_write ON redaction_patterns
  FOR ALL
  USING (current_user_is_admin())
  WITH CHECK (current_user_is_admin());

COMMIT;
