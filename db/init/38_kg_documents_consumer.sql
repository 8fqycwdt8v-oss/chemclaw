-- Tranche 5 / H5: register kg-documents as a consumer of document_ingested.
--
-- The Tranche 1 catalog (db/init/35_event_type_vocabulary.sql) seeded
-- `document_ingested` with consumed_by = ['chunk-embedder', 'contextual-chunker'].
-- Tranche 5 adds the kg_documents projector that turns documents + chunks
-- into Neo4j :Document and :Chunk nodes; this migration updates the catalog
-- so the consumer slot is accurate.
--
-- Re-applicable: ON CONFLICT DO UPDATE refreshes the row in place.

BEGIN;

INSERT INTO ingestion_event_catalog (event_type, description, emitted_by, consumed_by) VALUES
  ('document_ingested',
   'A document plus its chunks were inserted; signals embedding + chunking + KG '
   'projection work. As of Tranche 5 the kg-documents projector also reacts, '
   'building the :Document → HAS_CHUNK → :Chunk graph chain that future '
   'extraction layers + provenance traversal walk.',
   'services/ingestion/doc_ingester/importer.py',
   ARRAY['chunk-embedder', 'contextual-chunker', 'kg-documents'])
ON CONFLICT (event_type) DO UPDATE SET
  description = EXCLUDED.description,
  emitted_by  = EXCLUDED.emitted_by,
  consumed_by = EXCLUDED.consumed_by;

COMMIT;
