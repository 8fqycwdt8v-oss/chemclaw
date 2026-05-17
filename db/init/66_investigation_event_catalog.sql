-- db/init/66_investigation_event_catalog.sql
--
-- Universal Knowledge Accumulation — Phase 0
-- Registers the new ingestion event types for the universal knowledge
-- accumulation pipeline. ingestion_event_catalog is documentation only
-- (no FK / CHECK on event_type), but it's the canonical vocabulary list
-- and is referenced from code reviews and the design spec.

BEGIN;

-- NOTE: tool_invocation_complete, extracted_fact, anomaly_observed,
-- investigation_requested, and pattern_detected are registered by
-- 35_event_type_vocabulary.sql (which is authoritative). This file registers
-- only the Phase 3–5 event types not present in that file.
INSERT INTO ingestion_event_catalog (event_type, description, emitted_by, consumed_by) VALUES
  ('interpretation_proposed',
   'LLM interpreter emitted a derived claim from a source fact + KG context. '
   'Class is always INTERPRETED.',
   'services/projectors/interpreter/main.py (Phase 3)',
   ARRAY['investigation_scorer', 'wiki_regen']),
  ('test_planned',
   'test_planner identified a discriminating test for an active hypothesis. '
   'Payload carries either a task_queue enqueue, a workflow_runs row, or a '
   'synthesis-campaign step proposal.',
   'services/projectors/test_planner/main.py (Phase 5)',
   ARRAY['workflow_engine', 'queue']),
  ('external_data_fetched',
   'An external feed (CrossRef, PubMed, USPTO, ORD) fetched a new record. '
   'Routes through doc_ingester or the per-feed direct extractor.',
   'services/optimizer/external_feeds/* (Phase 2)',
   ARRAY['doc_ingester', 'crossref_extractor', 'pubmed_extractor',
         'uspto_extractor', 'ord_extractor'])
ON CONFLICT (event_type) DO UPDATE SET
  description = EXCLUDED.description,
  emitted_by  = EXCLUDED.emitted_by,
  consumed_by = EXCLUDED.consumed_by;

INSERT INTO schema_version (filename, applied_at)
VALUES ('66_investigation_event_catalog.sql', NOW())
ON CONFLICT (filename) DO NOTHING;

COMMIT;
