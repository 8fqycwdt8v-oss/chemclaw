-- Schema version tracking — applied first (00_ prefix sorts before 01_).
-- Provides visibility into which init files have been applied without
-- introducing a heavyweight migration tool. The Makefile loop INSERTs
-- one row per file as it is applied (ON CONFLICT DO NOTHING).

BEGIN;

CREATE TABLE IF NOT EXISTS schema_version (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
