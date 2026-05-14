-- Orphan-detection view for synthesis_campaign_steps.{ref_table, ref_id}.
--
-- 51_synthesis_campaigns.sql intentionally uses a soft FK pattern for the
-- ref_table/ref_id pointer: the referenced rows can live in different
-- schemas (`public.optimization_campaigns`, `mock_eln.entries`, etc.) and
-- some are routinely deleted as part of cleanup, so a hard FK isn't
-- usable. The 2026-05-09 code-completeness review flagged this as a
-- silent-orphan risk — a step's ref_id can dangle with no warning.
--
-- This view materialises the integrity check on demand. Operators run:
--   SELECT * FROM v_synthesis_campaign_step_orphans;
-- and any rows returned indicate steps whose ref pointer no longer
-- resolves. Cron / cluster F follow-ups can wrap this in a daily job
-- and emit error_events on non-empty results.
--
-- The view is read-only and safe to materialise lazily; it does
-- one EXISTS-subquery LEFT JOIN per allowed ref_table value, gated
-- by a top-level WHERE so the optimiser can prune correctly.

CREATE OR REPLACE VIEW v_synthesis_campaign_step_orphans AS
SELECT
  s.id                AS step_id,
  s.campaign_id,
  s.step_index,
  s.kind,
  s.status,
  s.ref_table,
  s.ref_id,
  s.created_at,
  s.updated_at
FROM synthesis_campaign_steps s
WHERE s.ref_table IS NOT NULL
  AND s.ref_id   IS NOT NULL
  -- For each allowed ref_table, check the row still exists. Anything
  -- not handled here (a future allowed value, or a malformed row that
  -- somehow passed the CHECK) falls through as an orphan so the gap
  -- is visible rather than silent.
  AND NOT EXISTS (
    SELECT 1 FROM optimization_campaigns x
     WHERE s.ref_table = 'optimization_campaigns' AND x.id::text = s.ref_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM optimization_rounds x
     WHERE s.ref_table = 'optimization_rounds' AND x.id::text = s.ref_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM chemspace_screens x
     WHERE s.ref_table = 'chemspace_screens' AND x.id::text = s.ref_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM chemspace_results x
     WHERE s.ref_table = 'chemspace_results' AND x.id::text = s.ref_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM workflow_runs x
     WHERE s.ref_table = 'workflow_runs' AND x.id::text = s.ref_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM genchem_runs x
     WHERE s.ref_table = 'genchem_runs' AND x.id::text = s.ref_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM task_batches x
     WHERE s.ref_table = 'task_batches' AND x.id::text = s.ref_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM qm_results x
     WHERE s.ref_table = 'qm_results' AND x.id::text = s.ref_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM reactions x
     WHERE s.ref_table = 'reactions' AND x.id::text = s.ref_id
  )
  -- mock_eln.entries / mock_eln.samples live in the testbed-only
  -- `mock_eln` schema. Including them here would fail the view
  -- definition on `sources`-profile deployments where the schema isn't
  -- present, and `to_regclass` is evaluated per-row at runtime so it
  -- can't gate parser-time table resolution. Operators on the testbed
  -- profile run a separate query when they need orphan detection for
  -- mock_eln refs (see docs/runbooks/synthesis-campaign-lifecycle.md).
  AND s.ref_table NOT IN ('mock_eln.entries', 'mock_eln.samples');

COMMENT ON VIEW v_synthesis_campaign_step_orphans IS
  'Steps whose soft-FK (ref_table, ref_id) no longer resolves. Empty in a healthy DB.';

-- Self-record for schema_version (Makefile loop is belt-and-suspenders).
INSERT INTO schema_version (filename, applied_at)
  VALUES ('53_synthesis_campaign_orphans.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;
