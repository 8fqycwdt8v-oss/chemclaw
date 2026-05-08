-- 50_redaction_patterns_notify.sql
--
-- pg_notify trigger on `redaction_patterns` so any LISTEN'er can
-- invalidate its cache on admin-side INSERT/UPDATE/DELETE without the
-- TTL-based polling fallback.
--
-- Architecture
-- ============
-- The litellm_redactor's DynamicPatternLoader caches DB-loaded patterns
-- with a 5s TTL (services/litellm_redactor/dynamic_patterns.py). Admin
-- mutations via /api/admin/redaction-patterns land in the DB but the
-- in-process cache only refreshes on the next post-TTL hit. This trigger
-- fires `NOTIFY redaction_patterns_changed '<scope>:<scope_id>'` on every
-- write so a listener can call `loader.invalidate()` immediately rather
-- than wait up to 5s.
--
-- Why a separate channel
-- ----------------------
-- `ingestion_events` is the canonical channel for projector pipelines —
-- it carries event-source rows, not config-mutation pings. Mixing
-- redaction-pattern admin events into ingestion_events would force every
-- projector to filter them out. A separate channel keeps the listener
-- mapping clean (one channel = one consumer interest) and avoids
-- polluting the projector ack table.
--
-- Wiring expectations
-- -------------------
-- The litellm container's runtime listener is commented out by default
-- (the litellm service itself ships commented in docker-compose.yml).
-- When operators uncomment the service, they should add a small
-- listener that LISTENs on this channel and calls
-- `DynamicPatternLoader.invalidate()`. Until then, the 5s TTL serves
-- as the operational fallback. This trigger lands ahead of the
-- listener so the wire protocol is fixed and listener implementations
-- can attach without DB-schema churn.
--
-- Idempotent: re-applying drops + re-creates the trigger / function.

BEGIN;

CREATE OR REPLACE FUNCTION notify_redaction_patterns_changed()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payload TEXT;
  row_scope TEXT;
  row_scope_id TEXT;
BEGIN
  -- Use NEW for INSERT/UPDATE, OLD for DELETE; both rows have the same
  -- scope columns the listener can filter on.
  IF (TG_OP = 'DELETE') THEN
    row_scope := OLD.scope;
    row_scope_id := OLD.scope_id;
  ELSE
    row_scope := NEW.scope;
    row_scope_id := NEW.scope_id;
  END IF;

  -- Payload is the smallest useful identifier so listeners can opt-in
  -- to scope-specific invalidation rather than a global cache flush.
  -- Empty payload is acceptable too — listeners that don't care can
  -- simply call invalidate() unconditionally.
  payload := COALESCE(row_scope, '') || ':' || COALESCE(row_scope_id, '');

  -- pg_notify is async + best-effort; if the LISTEN'er is offline the
  -- payload is dropped silently. That's the right semantic for cache
  -- invalidation — the next TTL refresh catches the change.
  PERFORM pg_notify('redaction_patterns_changed', payload);

  IF (TG_OP = 'DELETE') THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_redaction_patterns_notify ON redaction_patterns;

CREATE TRIGGER trg_redaction_patterns_notify
AFTER INSERT OR UPDATE OR DELETE ON redaction_patterns
FOR EACH ROW
EXECUTE FUNCTION notify_redaction_patterns_changed();

COMMENT ON FUNCTION notify_redaction_patterns_changed() IS
  'Emits NOTIFY redaction_patterns_changed on every redaction_patterns '
  'mutation so the litellm_redactor''s DynamicPatternLoader cache can '
  'be invalidated synchronously rather than waiting on the 5s TTL. '
  'Payload format: <scope>:<scope_id>. See db/init/50_redaction_'
  'patterns_notify.sql for the architecture rationale.';

INSERT INTO schema_version (filename)
VALUES ('50_redaction_patterns_notify.sql')
ON CONFLICT DO NOTHING;

COMMIT;
