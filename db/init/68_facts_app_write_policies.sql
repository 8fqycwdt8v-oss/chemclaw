-- db/init/68_facts_app_write_policies.sql
--
-- Universal Knowledge Accumulation — Phase 0 fix (Task 12)
--
-- Tasks 1 (62_facts_table.sql) and 3 (64_investigation_queue.sql) landed
-- `facts` and `investigation_queue` with only a chemclaw_service write
-- policy. The agent's pool connects as chemclaw_app (no BYPASSRLS), so
-- every INSERT from promote_to_kg / request_investigation is denied at
-- runtime. Unit tests miss this because the pool is mocked. This
-- migration adds tightly-scoped app-role INSERT policies.
--
-- The WITH CHECK clauses are deliberately strict: they encode what the
-- agent is *allowed* to insert at all, not just what it's authorized
-- against. So even if an agent (or a forged tool) bypasses the builtin's
-- per-class confidence cap, the DB still pins:
--   * facts:                derivation_class ∈ {INTERPRETED, HYPOTHESIZED,
--                            ABSTRACTED}, extractor_name ∈ {promote_to_kg,
--                            request_investigation}, source_table =
--                            'agent_promotion'.
--   * investigation_queue:  score = 1.0 AND 'manual_request' ∈
--                            reason_codes.
-- Anything else needs chemclaw_service (BYPASSRLS) — i.e., a projector
-- running outside the user-facing chat path. This is the "agent can't
-- forge OBSERVED rows" invariant.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- facts — chemclaw_app INSERT policy.
--
-- Restricts app-role inserts to agent-promotion / agent-derived facts.
-- The agent CANNOT insert OBSERVED or COMPUTED rows from this path
-- (those classes are reserved for the deterministic projectors which
-- run as chemclaw_service).
-- ─────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS facts_app_promote ON facts;
CREATE POLICY facts_app_promote ON facts
  FOR INSERT
  TO chemclaw_app
  WITH CHECK (
    extractor_name IN ('promote_to_kg', 'request_investigation')
    AND derivation_class IN ('INTERPRETED', 'HYPOTHESIZED', 'ABSTRACTED')
    AND source_table = 'agent_promotion'
    AND (
      project_id IS NULL
      OR EXISTS (
        SELECT 1 FROM user_project_access upa
        WHERE upa.nce_project_id = facts.project_id
          AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
      )
    )
  );

-- chemclaw_app needs INSERT grant in addition to the policy. SELECT was
-- already granted in 62_facts_table.sql; this idempotently adds INSERT.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT INSERT ON facts TO chemclaw_app;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- investigation_queue — chemclaw_app INSERT policy.
--
-- Restricts app-role inserts to user-requested enqueues. score must be
-- 1.0 (max-priority manual request) AND 'manual_request' must be a
-- reason_codes entry. Low-priority / periodic-sweep enqueues come from
-- chemclaw_service (BYPASSRLS) — the future investigation_scorer
-- projector.
-- ─────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS investigation_queue_app_request ON investigation_queue;
CREATE POLICY investigation_queue_app_request ON investigation_queue
  FOR INSERT
  TO chemclaw_app
  WITH CHECK (
    score = 1.0
    AND 'manual_request' = ANY(reason_codes)
    AND (
      project_id IS NULL
      OR EXISTS (
        SELECT 1 FROM user_project_access upa
        WHERE upa.nce_project_id = investigation_queue.project_id
          AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
      )
    )
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT INSERT ON investigation_queue TO chemclaw_app;
  END IF;
END $$;

INSERT INTO schema_version (filename, applied_at)
VALUES ('68_facts_app_write_policies.sql', NOW())
ON CONFLICT (filename) DO NOTHING;

COMMIT;
