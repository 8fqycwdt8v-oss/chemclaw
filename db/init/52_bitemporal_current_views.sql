-- Bi-temporal "current view" for hypotheses and artifacts.
--
-- Background: db/init/48_reactions_current_view.sql exposed `reactions_current`
-- as the canonical "current" projection of the reactions table (filtering
-- invalidated and superseded rows). The same pattern applies to hypotheses
-- (refuted_at IS NULL AND valid_to IS NULL) and artifacts (superseded_at IS
-- NULL). Without these views, the path of least resistance for a future
-- aggregation/list query is to read the raw table and forget the bi-temporal
-- predicate — exactly the bug class that BACKLOG.md:120 documented for
-- reactions before 48 landed.
--
-- security_invoker = true so RLS on the underlying table evaluates against
-- the calling user's app.current_user_entra_id GUC (set by withUserContext),
-- not the view owner. Required for FORCE ROW LEVEL SECURITY (set on both
-- tables in 12_security_hardening.sql / 16_db_audit_fixes.sql) to gate the
-- view's output to the same row set the user can see on the base table.
--
-- Single-row lookups by id may still query the base table directly when the
-- caller wants to inspect bi-temporal history (current behaviour of
-- update_hypothesis_status.ts and kg_hypotheses/main.py is correct).

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. hypotheses_current
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.hypotheses') IS NOT NULL THEN
    EXECUTE '
      CREATE OR REPLACE VIEW hypotheses_current
        WITH (security_invoker = true) AS
        SELECT *
          FROM hypotheses
         WHERE refuted_at IS NULL
           AND valid_to   IS NULL
    ';

    -- Best-effort comment + grants. View existence is guarded above; if we
    -- got here, the view exists.
    EXECUTE 'COMMENT ON VIEW hypotheses_current IS '
            '''Current-state projection of hypotheses: refuted_at IS NULL '
            'AND valid_to IS NULL. Use for any aggregation / list / scoring '
            'query that should not see refuted or superseded hypotheses. '
            'Single-row lookups by id may still query the base table.''';

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
      EXECUTE 'GRANT SELECT ON hypotheses_current TO chemclaw_app';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
      EXECUTE 'GRANT SELECT ON hypotheses_current TO chemclaw_service';
    END IF;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. artifacts_current
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.artifacts') IS NOT NULL THEN
    EXECUTE '
      CREATE OR REPLACE VIEW artifacts_current
        WITH (security_invoker = true) AS
        SELECT *
          FROM artifacts
         WHERE superseded_at IS NULL
    ';

    EXECUTE 'COMMENT ON VIEW artifacts_current IS '
            '''Current-state projection of artifacts: superseded_at IS NULL. '
            'Use for any aggregation / list / promotion query that should '
            'not see superseded artifacts. Single-row lookups by id may '
            'still query the base table to inspect history.''';

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
      EXECUTE 'GRANT SELECT ON artifacts_current TO chemclaw_app';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
      EXECUTE 'GRANT SELECT ON artifacts_current TO chemclaw_service';
    END IF;
  END IF;
END $$;

INSERT INTO schema_version (filename)
VALUES ('52_bitemporal_current_views.sql')
ON CONFLICT DO NOTHING;

COMMIT;
