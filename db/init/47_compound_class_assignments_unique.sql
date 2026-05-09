-- Cluster C: enforce no-duplicate-live invariant on
-- compound_class_assignments at the storage layer.
--
-- Today the no-duplicate-live invariant ((inchikey, class_id) WHERE
-- valid_to IS NULL → at most one row) is held only by the
-- pg_advisory_xact_lock taken in compound_classifier._classify (DR-14).
-- A direct INSERT (manual ops, future projector, replay, or any path
-- that bypasses the application lock) can produce duplicate live rows
-- silently, which then fan out into duplicate KG :Fact nodes and
-- weighted similarity hits.
--
-- A partial unique index enforces the invariant at the DB layer too.
-- Belt-and-braces: the application lock keeps writes serialised across
-- replicas (advisory lock is cluster-scoped); the index catches any
-- write that bypasses the application path.
--
-- Backfill order:
--   1. Close any pre-existing duplicates by setting valid_to = NOW()
--      on all but the most-recent (inchikey, class_id) row. The
--      most-recent row keeps valid_to IS NULL.
--   2. Create the partial unique index. CREATE UNIQUE INDEX is fast
--      against a deduped table; bounded scan over distinct keys.

BEGIN;

-- 1. Dedupe live duplicates. A `live` row is one with valid_to IS NULL.
-- For each (inchikey, class_id), keep the row with the latest
-- valid_from; close every other live row by setting valid_to = NOW().
WITH live_dups AS (
  SELECT
    inchikey,
    class_id,
    valid_from,
    ROW_NUMBER() OVER (
      PARTITION BY inchikey, class_id
      ORDER BY valid_from DESC
    ) AS rn
  FROM compound_class_assignments
  WHERE valid_to IS NULL
)
UPDATE compound_class_assignments a
   SET valid_to = NOW()
  FROM live_dups d
 WHERE a.inchikey   = d.inchikey
   AND a.class_id   = d.class_id
   AND a.valid_from = d.valid_from
   AND a.valid_to IS NULL
   AND d.rn > 1;

-- 2. Partial unique index — enforces the invariant going forward.
CREATE UNIQUE INDEX IF NOT EXISTS uq_compound_class_assignments_live
  ON compound_class_assignments (inchikey, class_id)
  WHERE valid_to IS NULL;


-- Self-record for schema_version (Makefile loop is belt-and-suspenders).
INSERT INTO schema_version (filename)
VALUES ('47_compound_class_assignments_unique.sql')
ON CONFLICT DO NOTHING;
COMMIT;
