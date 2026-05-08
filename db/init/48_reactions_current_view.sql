-- Bi-temporal "current view" for the reactions table.
--
-- Background: reactions carry valid_from / valid_to / invalidated bi-temporal
-- columns (db/init/17_unified_confidence_and_temporal.sql). Multiple agent
-- builtins and baseline trainers have been reading the raw `reactions` table
-- without filtering retracted / superseded rows, polluting:
--   - similarity / nearest-neighbor search (find_similar_reactions)
--   - applicability-domain calibration (assess_applicability_domain)
--   - yield-model training pairs (predict_yield_with_uq, build_global_xgb)
--   - statistical aggregation (statistical_analyze)
--   - reaction-context expansion (expand_reaction_context predecessors)
--
-- This view exposes the canonical "current" projection. Callers updated to
-- read FROM reactions_current automatically inherit the bi-temporal filter
-- and stay correct when invalidations land.
--
-- security_invoker = true so that RLS on the underlying `reactions` table
-- evaluates against the calling user's `app.current_user_entra_id` context
-- (set by withUserContext), not the view owner. Required for FORCE ROW
-- LEVEL SECURITY (db/init/12_security_hardening.sql) to gate the view's
-- output to the same row set the user can see on the base table.

BEGIN;

CREATE OR REPLACE VIEW reactions_current
  WITH (security_invoker = true) AS
  SELECT *
    FROM reactions
   WHERE invalidated IS NOT TRUE
     AND valid_to IS NULL;

COMMENT ON VIEW reactions_current IS
  'Current-state projection of reactions: invalidated IS NOT TRUE AND valid_to IS NULL. '
  'Use for any aggregation / similarity / training query that should not see retracted '
  'or superseded rows. Single-row lookups by id may still query the base `reactions` '
  'table directly when the caller wants to inspect bi-temporal history.';

-- Both app and service roles need SELECT for projector + agent flows.
GRANT SELECT ON reactions_current TO chemclaw_app;
GRANT SELECT ON reactions_current TO chemclaw_service;

-- Self-record so `make db.init` can spot which init files have applied
-- against a given database. Several earlier init files (30–47) were
-- inconsistent about this; new files MUST self-record.
INSERT INTO schema_version (filename)
VALUES ('48_reactions_current_view.sql')
ON CONFLICT DO NOTHING;

COMMIT;
