-- db/init/72_conclusion_extractor_rls.sql
--
-- RLS policies for agent-hook writes to facts and ingestion_events.
--
-- Two hooks run inside withUserContext (chemclaw_app, NOBYPASSRLS):
--
--   1. kg-conclusion-extractor (Phase 6): INSERTs ABSTRACTED facts with
--      extractor_name='kg-conclusion-extractor', source_table='agent_turns',
--      then emits extracted_fact events to ingestion_events.
--
--   2. source-cache (Phase 0): emits source_fact_observed events to
--      ingestion_events. The original RLS file (41_event_log_rls.sql) was
--      written before source-cache.ts existed; this migration closes the gap.
--
-- Design posture:
--   * facts INSERT policy is tightly scoped to the specific extractor_name
--     and source_table used by this hook. The existing facts_app_promote
--     policy (68_facts_app_write_policies.sql) is unchanged.
--   * ingestion_events INSERT policy is scoped to the two event_type values
--     that agent hooks emit directly. Projectors and ingestion workers
--     (chemclaw_service, BYPASSRLS) are unaffected.
--
-- Idempotent: DROP IF EXISTS before CREATE POLICY; GRANT uses IF NOT EXISTS
-- semantics via the DO block.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. facts — INSERT policy for the kg-conclusion-extractor hook.
--
-- The existing policy (facts_app_promote) gates on extractor_name IN
-- ('promote_to_kg', 'request_investigation') with source_table='agent_promotion'.
-- This adds a parallel permissive policy for the Phase 6 hook. PostgreSQL
-- ORs permissive INSERT WITH CHECK clauses, so either policy can allow a row.
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS facts_app_conclusion_extractor ON facts;
CREATE POLICY facts_app_conclusion_extractor ON facts
  FOR INSERT
  TO chemclaw_app
  WITH CHECK (
    extractor_name = 'kg-conclusion-extractor'
    AND derivation_class = 'ABSTRACTED'
    AND source_table = 'agent_turns'
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 2. ingestion_events — GRANT + INSERT policy for agent-hook event emission.
--
-- 41_event_log_rls.sql set FORCE ROW LEVEL SECURITY on ingestion_events with
-- no INSERT policy ("chemclaw_app cannot write through any policy, which is
-- the intent"). That pre-dated source-cache.ts (Phase 0) and
-- conclusion-extractor.ts (Phase 6). We open a narrow slot here: only the
-- two event_type values that agent hooks emit directly are allowed.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT INSERT ON ingestion_events TO chemclaw_app;
  END IF;
END $$;

DROP POLICY IF EXISTS ingestion_events_app_hook_insert ON ingestion_events;
CREATE POLICY ingestion_events_app_hook_insert ON ingestion_events
  FOR INSERT
  TO chemclaw_app
  WITH CHECK (
    event_type IN ('extracted_fact', 'source_fact_observed')
  );

-- ────────────────────────────────────────────────────────────────────────────
-- Schema version
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO schema_version (filename)
VALUES ('72_conclusion_extractor_rls.sql')
ON CONFLICT DO NOTHING;

COMMIT;
