-- Drop the dead `corrections` table.
--
-- `corrections` was created in 01_schema.sql as part of "Self-Improvement,
-- Deliverable 6" but never wired: zero readers, zero writers, no admin
-- route, no projector. The actual correction-handling path is
-- `feedback_events` (signal='correction' + correction_payload JSONB),
-- which is wired through /feedback. Carrying both was confusing — the
-- 2026-05-09 code-completeness review flagged it as L1 dead schema.
--
-- The CREATE statement was removed from 01_schema.sql; this file drops
-- the table on existing deployments. Idempotent.

BEGIN;

DROP TABLE IF EXISTS corrections;
-- Self-record for schema_version (Makefile loop is belt-and-suspenders).
INSERT INTO schema_version (filename, applied_at)
  VALUES ('52_drop_corrections.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
