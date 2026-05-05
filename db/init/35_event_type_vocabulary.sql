-- Tranche 1 / C3+C4: ingestion_events vocabulary catalog + the missing
-- hypothesis_status_changed emitter.
--
-- Background:
--   * `ingestion_events.event_type` is a permissive TEXT column. There is no
--     CHECK constraint and no enum — adding one without a long migration plan
--     would risk breaking historical rows. Instead we add a *catalog* table
--     that documents the vocabulary in-database and is referenced from code
--     reviews. Future tranches can add a soft FK or CHECK once the vocabulary
--     is stable.
--   * `kg_hypotheses` projector subscribes to `hypothesis_status_changed`
--     (services/projectors/kg_hypotheses/main.py:31) but no code emitted the
--     event. Refutations and archivals therefore never reached Neo4j via the
--     projector chain. We close that loop with a defensive trigger on
--     `hypotheses` UPDATE that fires the event whenever `status` actually
--     changes.
--
-- Re-applicable: every CREATE/INSERT uses IF NOT EXISTS / ON CONFLICT.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Vocabulary catalog
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingestion_event_catalog (
  event_type    TEXT PRIMARY KEY,
  description   TEXT NOT NULL,
  emitted_by    TEXT NOT NULL,
  consumed_by   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE ingestion_event_catalog IS
  'Documents every event_type emitted to ingestion_events: who emits, who '
  'consumes. Not enforced via FK so history is preserved if a row is removed; '
  'CI / code review treat it as the canonical vocabulary list.';

INSERT INTO ingestion_event_catalog (event_type, description, emitted_by, consumed_by) VALUES
  ('experiment_imported',
   'A canonical experiment + reaction tree was inserted into Postgres.',
   'services/ingestion/eln_json_importer.legacy/importer.py',
   ARRAY['kg-experiments', 'reaction-vectorizer', 'conditions-normalizer']),
  ('document_ingested',
   'A document plus its chunks were inserted; signals embedding + chunking work.',
   'services/ingestion/doc_ingester/importer.py',
   ARRAY['chunk-embedder', 'contextual-chunker']),
  ('hypothesis_proposed',
   'Agent persisted a new hypothesis row.',
   'services/agent-claw/src/tools/builtins/propose_hypothesis.ts',
   ARRAY['kg_hypotheses']),
  ('hypothesis_status_changed',
   'A hypotheses.status transitioned (e.g. proposed -> refuted -> archived). '
   'Emitted defensively by trigger on UPDATE so direct-SQL writes also reach the projector.',
   'db/init/35_event_type_vocabulary.sql (trigger trg_hypotheses_status_event)',
   ARRAY['kg_hypotheses']),
  ('source_fact_observed',
   'Post-tool hook captured a structured fact from a source-system tool '
   '(query_eln_*, fetch_eln_*, fetch_instrument_*) and forwarded it for KG caching.',
   'services/agent-claw/src/core/hooks/source-cache.ts',
   ARRAY['kg-source-cache']),
  ('qm_job_succeeded',
   'A QM/DFT/xTB job completed and its results were materialised. Currently '
   'broadcast on a custom NOTIFY channel (db/init/23_qm_results.sql) consumed by '
   'the qm_kg projector; Tranche 2 routes this through ingestion_events.',
   'db/init/23_qm_results.sql (legacy custom NOTIFY)',
   ARRAY['qm-kg']),
  -- Reserved vocabulary for later tranches. Defined here so the catalog is
  -- the single source of truth for what event_types exist; emitters and
  -- consumers will be wired in Tranche 2 (cascade) and Tranche 5 (corrections).
  ('fact_invalidated',
   'Reserved (Tranche 2). A KG fact was invalidated, e.g. cascading from a '
   'refuted hypothesis. Carries fact_id + reason in payload.',
   'reserved',
   ARRAY['kg-source-cache']),
  ('reaction_corrected',
   'Reserved (Tranche 5). A canonical reaction row received a correction; '
   'downstream caches must invalidate.',
   'reserved',
   ARRAY['reaction-vectorizer', 'kg-experiments']),
  ('artifact_corrected',
   'Reserved (Tranche 5). An artifact row was superseded with a correction; '
   'confidence ensemble + KG facts derived from it must be re-evaluated.',
   'reserved',
   ARRAY['kg-experiments']),
  ('workflow_run_succeeded',
   'A workflow_runs row reached status=succeeded. Carries run_id + outputs '
   'in payload; downstream KG projectors materialise the workflow''s named '
   'outputs against the canonical state. Failed runs do NOT emit — they '
   'surface only via workflow_events.kind=step_failed/finish.',
   'services/workflow_engine/main.py:_finish',
   ARRAY['kg-experiments'])
ON CONFLICT (event_type) DO UPDATE SET
  description = EXCLUDED.description,
  emitted_by  = EXCLUDED.emitted_by,
  consumed_by = EXCLUDED.consumed_by;

-- Catalog reads are global; service workers + admins read it. No RLS — it's
-- documentation, not user data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT ON ingestion_event_catalog TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON ingestion_event_catalog TO chemclaw_service;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Defensive trigger: emit hypothesis_status_changed on every status
--    transition, regardless of which code path did the UPDATE.
--
--    Idempotency: WHEN clause filters no-op updates, so re-running the same
--    UPDATE statement (which Postgres allows) does not double-emit. The
--    target projector (kg_hypotheses) is also idempotent via MERGE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION emit_hypothesis_status_changed()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Mirror the propose_hypothesis emission shape: source_table, source_row_id,
  -- payload carries hypothesis_id + transition. The kg_hypotheses projector
  -- already reads source_row_id as the fallback hypothesis_id.
  INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
  VALUES (
    'hypothesis_status_changed',
    'hypotheses',
    NEW.id,
    jsonb_build_object(
      'hypothesis_id', NEW.id::text,
      'old_status',    OLD.status,
      'new_status',    NEW.status
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hypotheses_status_event ON hypotheses;
CREATE TRIGGER trg_hypotheses_status_event
  AFTER UPDATE OF status ON hypotheses
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION emit_hypothesis_status_changed();

COMMIT;
