-- Phase G hardening: enable RLS on the event-sourcing logs.
--
-- ingestion_events is the canonical stream — every projector consumes it,
-- and its `payload` JSONB carries cross-tenant artefacts (ELN row ids,
-- document hashes, fact ids, source-cache fact bodies). Until this
-- migration the table had no RLS, and 12_security_hardening.sql grants
-- SELECT to chemclaw_app on every public table — meaning any
-- authenticated session could read every other tenant's event payloads.
--
-- projection_acks leaks projector lag information across tenants in the
-- same way (the ack rows include event_id and projector_name).
--
-- Posture after this migration:
--   * chemclaw_service (BYPASSRLS) — projectors and ingestion workers,
--     unaffected. They read across tenants by design.
--   * chemclaw_app (NOBYPASSRLS) — admin-only SELECT via the policy
--     calling current_user_is_admin(); INSERT is blocked entirely
--     (forces ingestion through chemclaw_service).
--   * Direct app reads of ingestion_events / projection_acks were never
--     intended; app code reads derived views (KG, vectors, tables that
--     projectors maintain).

BEGIN;

ALTER TABLE ingestion_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ingestion_events_admin_select ON ingestion_events;
CREATE POLICY ingestion_events_admin_select ON ingestion_events
  FOR SELECT
  USING (current_user_is_admin());

-- No INSERT/UPDATE/DELETE policy: chemclaw_service bypasses RLS entirely
-- (BYPASSRLS), so ingestion workers continue to write unaffected.
-- chemclaw_app cannot write through any policy, which is the intent.

ALTER TABLE projection_acks ENABLE ROW LEVEL SECURITY;
ALTER TABLE projection_acks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS projection_acks_admin_select ON projection_acks;
CREATE POLICY projection_acks_admin_select ON projection_acks
  FOR SELECT
  USING (current_user_is_admin());


-- Self-record for schema_version (Makefile loop is belt-and-suspenders).
INSERT INTO schema_version (filename)
VALUES ('41_event_log_rls.sql')
ON CONFLICT DO NOTHING;
COMMIT;
