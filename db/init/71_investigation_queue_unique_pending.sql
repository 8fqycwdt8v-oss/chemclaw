-- db/init/71_investigation_queue_unique_pending.sql
--
-- Adds a partial UNIQUE index on investigation_queue(fact_id) WHERE picked_at IS NULL.
-- Without this, ON CONFLICT DO NOTHING on inserts is a no-op (no unique constraint
-- to conflict on), making the investigation_scorer projector non-idempotent on replay.
-- The partial index scopes uniqueness to pending (un-picked) entries only, so a fact
-- can be re-queued after its previous entry is picked up and completed.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_investigation_queue_unique_pending
  ON investigation_queue (fact_id)
  WHERE picked_at IS NULL;

INSERT INTO schema_version (filename, applied_at)
VALUES ('71_investigation_queue_unique_pending.sql', NOW())
ON CONFLICT (filename) DO NOTHING;

COMMIT;
