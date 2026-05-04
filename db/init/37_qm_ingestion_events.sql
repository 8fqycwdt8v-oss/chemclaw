-- Tranche 2 / C7: route `qm_job_succeeded` through the canonical
-- `ingestion_events` channel so projectors that LISTEN on the standard
-- channel (rather than the QM-specific custom NOTIFY) catch QM completions.
--
-- Background:
--   db/init/23_qm_results.sql defines `notify_qm_job_succeeded`, which
--   `pg_notify('qm_job_succeeded', NEW.id::text)`'s on the status transition
--   to 'succeeded'. The qm_kg projector LISTENs on that custom channel; no
--   other subscriber does. This means generic projectors / hooks that drive
--   off `ingestion_events` (the architectural spine) silently miss QM
--   completions.
--
--   We replace the function with a dual-write version: it keeps the legacy
--   custom NOTIFY (one-release backward-compat for any external listener that
--   may have been wired up) AND writes a canonical `ingestion_events` row
--   whose `id = NEW.id` (the qm_jobs UUID). The standard
--   `notify_ingestion_event` trigger on `ingestion_events` then fans the
--   event out on the canonical channel.
--
--   The deterministic id (= job_id) is what the qm_kg projector already
--   used as the `event_id` for `projection_acks`; this migration simply
--   moves that synthetic row from "qm_kg writes it on ack" to "trigger
--   writes it on the source UPDATE", so projection_acks and the canonical
--   event are in sync from the moment the job succeeds.
--
-- Re-applicable: CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER.

BEGIN;

CREATE OR REPLACE FUNCTION notify_qm_job_succeeded() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'succeeded' AND (TG_OP = 'INSERT' OR OLD.status <> 'succeeded') THEN
    -- 1) Legacy custom NOTIFY — kept for one release for backward compat.
    --    Will be removed in a follow-up tranche once we confirm no external
    --    listener depends on it.
    PERFORM pg_notify('qm_job_succeeded', NEW.id::text);

    -- 2) Canonical ingestion_events row. Deterministic id = job UUID so the
    --    qm_kg projector's projection_acks FK keeps working unchanged.
    --    ON CONFLICT (id) DO NOTHING handles any case where the row was
    --    already written (e.g. by qm_kg's defensive fallback on legacy data).
    INSERT INTO ingestion_events (id, event_type, source_table, source_row_id, payload)
    VALUES (NEW.id, 'qm_job_succeeded', 'qm_jobs', NEW.id, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger definition is unchanged from 23_qm_results.sql; we DROP+CREATE so
-- the trigger reflects the current function body in case Postgres caches.
DROP TRIGGER IF EXISTS trg_notify_qm_job_succeeded ON qm_jobs;
CREATE TRIGGER trg_notify_qm_job_succeeded
  AFTER INSERT OR UPDATE OF status ON qm_jobs
  FOR EACH ROW EXECUTE FUNCTION notify_qm_job_succeeded();

-- Update the catalog row to reflect that qm_job_succeeded is now ALSO emitted
-- via the canonical ingestion_events path (in addition to the legacy custom
-- NOTIFY channel). The list-style emitted_by makes the dual-write explicit.
INSERT INTO ingestion_event_catalog (event_type, description, emitted_by, consumed_by) VALUES
  ('qm_job_succeeded',
   'A QM/DFT/xTB job completed and its results were materialised. Dual-emitted: '
   '(1) custom pg_notify on the qm_job_succeeded channel (legacy, kept for one '
   'release of backward compat), (2) canonical ingestion_events row with id = '
   'qm_jobs.id so generic projectors LISTENing on ingestion_events also catch it.',
   'db/init/37_qm_ingestion_events.sql (trigger trg_notify_qm_job_succeeded)',
   ARRAY['qm-kg'])
ON CONFLICT (event_type) DO UPDATE SET
  description = EXCLUDED.description,
  emitted_by  = EXCLUDED.emitted_by,
  consumed_by = EXCLUDED.consumed_by;

COMMIT;
