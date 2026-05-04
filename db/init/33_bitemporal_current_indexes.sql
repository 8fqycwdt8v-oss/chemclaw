-- Tranche 1 / C2: partial indexes that make the bi-temporal "current" predicate
-- sargable on the tables augmented by 17_unified_confidence_and_temporal.sql.
--
-- Rationale: 17 added valid_from/valid_to/invalidated/refuted_at/superseded_at
-- columns but no indexes that match the typical "give me only current rows"
-- predicate. Once the read sites started filtering on these columns
-- (Tranche 1 / C1 commits), every "current facts" lookup did a sequential scan
-- followed by RLS filtering. This file ships the matching partial indexes.
--
-- Pattern lifted from db/init/25_compound_ontology.sql:51–55 — partial indexes
-- with `WHERE valid_to IS NULL` are already the convention in this repo for
-- bi-temporal tables.
--
-- Re-applicable: every CREATE INDEX uses IF NOT EXISTS.

BEGIN;

-- ---------------------------------------------------------------------------
-- reactions: scoped via experiment_id (no direct project column; project
-- access is enforced through experiments → synthetic_steps → nce_projects RLS).
-- The "current reactions for an experiment" lookup is the agent's hot path.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_reactions_current_by_experiment
  ON reactions (experiment_id)
  WHERE invalidated IS NOT TRUE AND valid_to IS NULL;

-- DRFP similarity over current reactions only — used by build_drfp_stats.py
-- and any future "find similar reactions" caller that wants to exclude
-- retracted vectors from the corpus.
CREATE INDEX IF NOT EXISTS idx_reactions_current_with_drfp
  ON reactions (created_at)
  WHERE invalidated IS NOT TRUE
    AND valid_to IS NULL
    AND drfp_vector IS NOT NULL;

-- ---------------------------------------------------------------------------
-- hypotheses: scoped via scope_nce_project_id. The "active hypotheses in a
-- project" lookup is what the agent traverses for cross-project learning.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_hypotheses_current_by_scope
  ON hypotheses (scope_nce_project_id)
  WHERE refuted_at IS NULL AND valid_to IS NULL;

-- ---------------------------------------------------------------------------
-- artifacts: scoped via owner_entra_id (user-scoped, not project-scoped).
-- Guarded by table-existence check because the table is created in
-- 07_maturity_tiers.sql which 17 also guards.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.artifacts') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_artifacts_current_by_owner
              ON artifacts (owner_entra_id)
              WHERE superseded_at IS NULL';
  END IF;
END $$;

COMMIT;
