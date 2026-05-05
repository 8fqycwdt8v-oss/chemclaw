-- 39_compound_catalog_rls.sql — close the defense-in-depth gap on the
-- compound chemistry catalogs (compound_classes, compound_smarts_catalog,
-- compound_substructure_hits, compound_class_assignments).
--
-- Background:
--   * `compounds` itself is RLS+FORCE'd in 12_security_hardening.sql with a
--     "require non-empty app.current_user_entra_id" policy. Any chemclaw_app
--     query against `compounds` must establish a user context first; the
--     companion catalog tables (compound_classes etc.) had no RLS at all,
--     so a forgetful caller — or an unauthenticated direct chemclaw_app
--     connection — could enumerate the curated catalog while the same
--     connection is denied access to the compounds rows the catalog
--     classifies.
--   * The catalogs are global chemistry data (no project / user scoping),
--     same posture as `compounds`. The right gate is "authenticated session
--     required" matching `compounds_authenticated_policy`.
--
-- Writer paths verified before applying:
--   * Seeds (24_compound_fingerprints.sql / 25_compound_ontology.sql) have
--     already inserted by the time this file runs (lex order: 24 → 25 → 39).
--     Re-applies are no-ops via ON CONFLICT DO NOTHING.
--   * Projector writes (services/projectors/compound_fingerprinter,
--     compound_classifier) connect as chemclaw_service (BYPASSRLS) per
--     docker-compose.yml — unaffected by FORCE RLS.
--   * Agent reads (substructure_search.ts, classify_compound.ts,
--     match_smarts_catalog.ts, run_chemspace_screen.ts) go through
--     withSystemContext which sets app.current_user_entra_id = '__system__';
--     the require-auth predicate accepts that sentinel.
--
-- Re-applicable: ENABLE/FORCE are idempotent; DROP POLICY IF EXISTS guards.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- compound_smarts_catalog (24_compound_fingerprints.sql)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE compound_smarts_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE compound_smarts_catalog FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS compound_smarts_catalog_authenticated ON compound_smarts_catalog;
CREATE POLICY compound_smarts_catalog_authenticated ON compound_smarts_catalog
  FOR ALL
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  )
  WITH CHECK (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  );

-- ────────────────────────────────────────────────────────────────────────────
-- compound_substructure_hits (24_compound_fingerprints.sql)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE compound_substructure_hits ENABLE ROW LEVEL SECURITY;
ALTER TABLE compound_substructure_hits FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS compound_substructure_hits_authenticated ON compound_substructure_hits;
CREATE POLICY compound_substructure_hits_authenticated ON compound_substructure_hits
  FOR ALL
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  )
  WITH CHECK (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  );

-- ────────────────────────────────────────────────────────────────────────────
-- compound_classes (25_compound_ontology.sql)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE compound_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE compound_classes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS compound_classes_authenticated ON compound_classes;
CREATE POLICY compound_classes_authenticated ON compound_classes
  FOR ALL
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  )
  WITH CHECK (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  );

-- ────────────────────────────────────────────────────────────────────────────
-- compound_class_assignments (25_compound_ontology.sql)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE compound_class_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE compound_class_assignments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS compound_class_assignments_authenticated ON compound_class_assignments;
CREATE POLICY compound_class_assignments_authenticated ON compound_class_assignments
  FOR ALL
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  )
  WITH CHECK (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  );

-- ────────────────────────────────────────────────────────────────────────────
-- schema_version provenance — self-record so the catalog matches actual state.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO schema_version (filename, applied_at)
  VALUES ('39_compound_catalog_rls.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
