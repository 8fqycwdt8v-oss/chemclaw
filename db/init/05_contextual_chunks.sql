-- Phase C.2: semantic uplift — contextual_chunker schema additions.
-- Adds contextual_prefix and page_number columns to document_chunks.
-- Re-applicable: ALTER TABLE ... ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS contextual_prefix TEXT,
  ADD COLUMN IF NOT EXISTS page_number INT;

-- Index on page_number for PDF provenance lookups.
CREATE INDEX IF NOT EXISTS idx_document_chunks_page_number
  ON document_chunks(document_id, page_number)
  WHERE page_number IS NOT NULL;

COMMENT ON COLUMN document_chunks.contextual_prefix IS
  'LLM-generated 1-3 sentence context situating this chunk within the document. '
  'Prepended to chunk text before embedding by the contextual_chunker projector. '
  'NULL for chunks processed before Phase C.2 (chunk_embedder falls back to text-only).';

COMMENT ON COLUMN document_chunks.page_number IS
  'Page number (1-indexed) within the source PDF. NULL for non-PDF documents '
  'or chunks ingested before Phase C.2 backfill.';

COMMIT;
