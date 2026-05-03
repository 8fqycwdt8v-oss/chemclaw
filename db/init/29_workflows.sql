-- Phase 8 — agent-controlled workflow engine.
--
-- Workflows-as-data on the A-on-C event log. Six agent-callable surfaces
-- (define/run/inspect/pause_resume/modify/replay) each gated by
-- permission_policies and audited via the existing admin_audit_log path.
--
-- Bi-temporal definitions (workflows.valid_from/valid_to) so a definition
-- can be amended without losing the prior shape. Runs are append-only:
-- workflow_events is the canonical state, workflow_state is a materialized
-- projection rebuildable by folding events.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. workflows — bi-temporal definitions
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflows (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL,
  definition    JSONB NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_from    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to      TIMESTAMPTZ,
  UNIQUE (name, version)
);

CREATE INDEX IF NOT EXISTS idx_workflows_name_live
  ON workflows (name) WHERE valid_to IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. workflow_runs — one row per execution
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_runs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  parent_run_id   UUID REFERENCES workflow_runs(id) ON DELETE SET NULL,
  session_id      UUID,  -- intentionally not FK'd to agent_sessions; runs may outlive sessions
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','paused','succeeded','failed','cancelled')),
  input           JSONB NOT NULL DEFAULT '{}'::jsonb,
  output          JSONB,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  paused_at       TIMESTAMPTZ,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
  ON workflow_runs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_session
  ON workflow_runs (session_id) WHERE session_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. workflow_events — durable event log; canonical state lives here
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_events (
  id            BIGSERIAL PRIMARY KEY,
  run_id        UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'start','step_started','step_succeeded','step_failed','step_skipped',
                  'pause','resume','modify','replay','finish'
                )),
  step_id       TEXT,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_run_seq
  ON workflow_events (run_id, seq);

CREATE OR REPLACE FUNCTION notify_workflow_event() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('workflow_event', NEW.run_id::text || ':' || NEW.seq::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_workflow_event ON workflow_events;
CREATE TRIGGER trg_notify_workflow_event
  AFTER INSERT ON workflow_events
  FOR EACH ROW EXECUTE FUNCTION notify_workflow_event();

-- ────────────────────────────────────────────────────────────────────────────
-- 4. workflow_state — materialized projection
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_state (
  run_id         UUID PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
  current_step   TEXT,
  scope          JSONB NOT NULL DEFAULT '{}'::jsonb,
  cursor         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. workflow_modifications — every modify is also written to workflow_events
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_modifications (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id              UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  before_definition   JSONB NOT NULL,
  after_definition    JSONB NOT NULL,
  applied_by          TEXT NOT NULL,
  justification       TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────────────
-- 6. RLS / grants
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT, INSERT, UPDATE
      ON workflows, workflow_runs, workflow_events,
         workflow_state, workflow_modifications
      TO chemclaw_app;
    GRANT USAGE, SELECT ON SEQUENCE workflow_events_id_seq TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON workflows, workflow_runs, workflow_events,
         workflow_state, workflow_modifications
      TO chemclaw_service;
    GRANT USAGE, SELECT ON SEQUENCE workflow_events_id_seq TO chemclaw_service;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Permission policies — every workflow op is auditable
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO permission_policies (scope, scope_id, decision, tool_pattern, reason, created_by) VALUES
  ('global', '', 'allow', 'workflow_define',  'Workflow definitions are versioned + audited; auto-allow.', '__system__'),
  ('global', '', 'allow', 'workflow_run',     'Workflow execution is gated step-by-step by underlying tool policies.', '__system__'),
  ('global', '', 'allow', 'workflow_inspect', 'Read-only.', '__system__'),
  ('global', '', 'ask',   'workflow_pause_resume', 'Operational; ask before pausing a running workflow.', '__system__'),
  ('global', '', 'ask',   'workflow_modify',  'Modifying a paused workflow rewrites the remaining plan; require confirmation.', '__system__'),
  ('global', '', 'ask',   'workflow_replay',  'Replays a finished workflow; ask to confirm input/definition overrides.', '__system__')
ON CONFLICT DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 8. schema_version
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO schema_version (filename, applied_at)
  VALUES ('29_workflows.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
