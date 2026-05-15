-- db/init/66_investigation_event_catalog.sql
--
-- Universal Knowledge Accumulation — Phase 0
-- Registers the new ingestion event types for the universal knowledge
-- accumulation pipeline. ingestion_event_catalog is documentation only
-- (no FK / CHECK on event_type), but it's the canonical vocabulary list
-- and is referenced from code reviews and the design spec.

BEGIN;

INSERT INTO ingestion_event_catalog (event_type, description, emitted_by, consumed_by) VALUES
  ('tool_invocation_complete',
   'Universal post-tool hook fires once per MCP / builtin call (success or '
   'failure). Payload carries tool_name + redacted args/result + result_schema_id '
   'for extractor dispatch. Failures emit with ok=false.',
   'services/agent-claw/src/core/hooks/tool-invocation-emitter.ts',
   ARRAY['tool_result_extractor']),
  ('extracted_fact',
   'A new row landed in the canonical facts table. Carries the fact_id in '
   'the payload. Downstream projectors load context from facts directly.',
   'services/projectors/tool_result_extractor/main.py and every per-source extractor',
   ARRAY['investigation_scorer', 'kg_facts_sync', 'wiki_pages']),
  ('anomaly_observed',
   'investigation_scorer detected an anomalous fact (z-score over threshold). '
   'Always routed to interpreter regardless of base score.',
   'services/projectors/investigation_scorer/main.py (Phase 3)',
   ARRAY['interpreter', 'hypothesis_former']),
  ('pattern_detected',
   'pattern_detector cron daemon clustered facts across entities and surfaced '
   'a significant cluster. Payload carries the cluster summary.',
   'services/optimizer/pattern_detector/main.py (Phase 4)',
   ARRAY['interpreter', 'hypothesis_former', 'wiki_regen']),
  ('interpretation_proposed',
   'LLM interpreter emitted a derived claim from a source fact + KG context. '
   'Class is always INTERPRETED.',
   'services/projectors/interpreter/main.py (Phase 3)',
   ARRAY['investigation_scorer', 'wiki_regen']),
  ('investigation_requested',
   'investigation_scorer flagged a fact for sync interpretation (score >= '
   'investigation.score_threshold_sync). The interpreter consumes this directly '
   'rather than polling the queue.',
   'services/projectors/investigation_scorer/main.py (Phase 3)',
   ARRAY['interpreter']),
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
