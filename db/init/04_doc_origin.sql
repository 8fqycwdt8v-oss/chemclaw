-- Phase B.1: add original_uri to documents for fidelity-preserving original-doc access.
-- Idempotent: ADD COLUMN IF NOT EXISTS; UPDATE is a safe no-op on subsequent runs
-- (documents already populated will satisfy the WHERE clause, nothing changes).
--
-- original_uri carries the canonical storage location of the raw source file:
--   file:///path   — local filesystem
--   https://...    — arbitrary HTTPS URL
--   s3://...       — S3-compatible object store
--   smb://...      — SMB/CIFS share
--   sharepoint://  — SharePoint document library (Phase F)
--
-- Backfill: where source_path is set and original_uri is NULL, we copy source_path
-- over. This preserves the existing convention without requiring re-ingestion.

BEGIN;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS original_uri TEXT;

-- Backfill from source_path where present.
UPDATE documents
   SET original_uri = source_path
 WHERE original_uri IS NULL
   AND source_path  IS NOT NULL;

COMMIT;
