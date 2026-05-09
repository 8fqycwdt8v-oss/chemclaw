-- Harden the `notify_ingestion_event` trigger.
--
-- Two changes:
--
--   1. Length-guard the NOTIFY payload. Postgres caps NOTIFY payloads at
--      ~7800 bytes (NOTIFY_PAYLOAD_MAX_LENGTH = 8000 minus framing). The
--      original trigger emitted only `id` + `event_type`, comfortably under
--      the cap. As soon as a future emitter wants to include a small piece
--      of context (e.g. compound_changed wants to carry the inchikey), the
--      cap becomes a silent failure mode — pg_notify raises and the
--      INSERT-trigger transaction aborts, taking the whole canonical write
--      with it. Pre-emptively truncate the payload and emit a structured
--      log record (`error_events`) so the failure is observable.
--
--   2. Strengthen the empty-user RLS gate on three owner-scoped tables
--      (feedback_events, corrections, notifications). The 12_security
--      _hardening.sql policies were `user_entra_id = current_setting(...)`
--      with no IS NOT NULL/<> '' guard. Currently safe because user_entra_id
--      is NOT NULL in the schema, but inconsistent with
--      42_session_policy_empty_user_guard.sql and one schema change away
--      from a fail-open footgun. Make every owner-scoped policy share the
--      same explicit guard.
--
-- Re-applicable: CREATE OR REPLACE FUNCTION + DROP-CREATE POLICY.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Replace notify_ingestion_event with a length-guarded version.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION notify_ingestion_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_payload TEXT;
  -- NOTIFY hard cap is 8000 bytes; reserve headroom for framing.
  c_notify_max_bytes CONSTANT INTEGER := 7000;
BEGIN
  v_payload := json_build_object('id', NEW.id, 'event_type', NEW.event_type)::text;

  IF octet_length(v_payload) > c_notify_max_bytes THEN
    -- Pathological event_type or future payload-extension. Forward to
    -- error_events for observability and emit a minimal NOTIFY (id only)
    -- so the projector can still LOOKUP-by-id and recover. We never let
    -- pg_notify itself raise — that would abort the canonical INSERT.
    BEGIN
      PERFORM record_error_event(
        'ingestion_events',
        'NOTIFY_PAYLOAD_OVERSIZE',
        'warn',
        json_build_object(
          'event_id',     NEW.id,
          'event_type',   NEW.event_type,
          'payload_bytes', octet_length(v_payload)
        )::jsonb
      );
    EXCEPTION WHEN OTHERS THEN
      -- record_error_event itself failed (no partition / RLS misconfig);
      -- swallow — we must not fail the source INSERT.
      NULL;
    END;
    v_payload := json_build_object('id', NEW.id)::text;
  END IF;

  PERFORM pg_notify('ingestion_events', v_payload);
  RETURN NEW;
END;
$$;

-- Trigger definition unchanged.
DROP TRIGGER IF EXISTS trg_notify_ingestion_event ON ingestion_events;
CREATE TRIGGER trg_notify_ingestion_event
  AFTER INSERT ON ingestion_events
  FOR EACH ROW EXECUTE FUNCTION notify_ingestion_event();

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Empty-user guards on owner-scoped policies.
-- ────────────────────────────────────────────────────────────────────────────

-- feedback_events
DROP POLICY IF EXISTS feedback_events_owner_policy ON feedback_events;
CREATE POLICY feedback_events_owner_policy ON feedback_events
  FOR ALL
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
    AND user_entra_id = current_setting('app.current_user_entra_id', true)
  )
  WITH CHECK (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
    AND user_entra_id = current_setting('app.current_user_entra_id', true)
  );

-- corrections
DROP POLICY IF EXISTS corrections_owner_policy ON corrections;
CREATE POLICY corrections_owner_policy ON corrections
  FOR ALL
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
    AND user_entra_id = current_setting('app.current_user_entra_id', true)
  )
  WITH CHECK (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
    AND user_entra_id = current_setting('app.current_user_entra_id', true)
  );

-- notifications
DROP POLICY IF EXISTS notifications_owner_policy ON notifications;
CREATE POLICY notifications_owner_policy ON notifications
  FOR ALL
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
    AND user_entra_id = current_setting('app.current_user_entra_id', true)
  )
  WITH CHECK (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
    AND user_entra_id = current_setting('app.current_user_entra_id', true)
  );

INSERT INTO schema_version (filename)
VALUES ('55_ingestion_event_notify_hardening.sql')
ON CONFLICT DO NOTHING;

COMMIT;
