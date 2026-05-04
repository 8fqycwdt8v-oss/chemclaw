-- Tranche 2 / C5: promote `fact_invalidated` from "reserved" to actively
-- emitted by the kg_hypotheses cascade.
--
-- Tranche 1 (db/init/35_event_type_vocabulary.sql) seeded `fact_invalidated`
-- with emitted_by='reserved' because the cascade hadn't shipped yet. Now
-- that the kg_hypotheses projector emits one fact_invalidated event per
-- :CITES edge it closes when its hypothesis transitions to status='refuted',
-- the catalog row needs to point at the actual emitter so future code review
-- has accurate provenance. The consumer slot stays empty for now —
-- Tranche 5 wires kg-source-cache (and a vector-cache evictor) to consume.
--
-- Re-applicable: ON CONFLICT DO UPDATE refreshes the row in place.

BEGIN;

INSERT INTO ingestion_event_catalog (event_type, description, emitted_by, consumed_by) VALUES
  ('fact_invalidated',
   'A KG fact (specifically a :CITES edge) was invalidated, currently as a '
   'cascade from a hypothesis transitioning to status=refuted. Carries the '
   'cited fact_id, the closed edge fact_id, and the invalidating hypothesis_id '
   'in the payload so consumers can re-derive provenance.',
   'services/projectors/kg_hypotheses/main.py (KgHypothesesProjector._emit_fact_invalidated_events)',
   ARRAY[]::TEXT[])
ON CONFLICT (event_type) DO UPDATE SET
  description = EXCLUDED.description,
  emitted_by  = EXCLUDED.emitted_by,
  consumed_by = EXCLUDED.consumed_by;

COMMIT;
