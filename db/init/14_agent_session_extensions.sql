-- Agent autonomy upgrade — Round 2: cross-turn budget, etag concurrency,
-- DB-backed plans, auto-resume counter.
-- See docs/plans/agent-claw-autonomy-upgrade.md (Phases E–I).
--
-- All changes are additive (ALTER TABLE ... IF NOT EXISTS) on top of
-- 13_agent_sessions.sql so an upgrade is a no-op rerun.

BEGIN;

-- --------------------------------------------------------------------
-- Phase H — etag for optimistic concurrency.
--
-- Each UPDATE regenerates etag via the trigger below. Clients pass the
-- etag they last loaded as expected_etag in saveSession; mismatch raises
-- OptimisticLockError and the client must reload + retry.
-- --------------------------------------------------------------------
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS etag UUID NOT NULL DEFAULT uuid_generate_v4();

CREATE OR REPLACE FUNCTION agent_sessions_regen_etag()
RETURNS TRIGGER AS $$
BEGIN
  -- Regenerate when ANY mutable column changes. Originally we only bumped
  -- on user-facing columns (scratchpad/last_finish_reason/awaiting_question/
  -- message_count) but that left a hole: a parallel writer that bumped
  -- only the budget counters (session_input_tokens/output_tokens/steps) or
  -- auto_resume_count would leave etag unchanged, letting the next
  -- expectedEtag check pass and silently overwrite the increment.
  -- Including the counter columns closes the bypass.
  IF NEW.scratchpad IS DISTINCT FROM OLD.scratchpad
     OR NEW.last_finish_reason IS DISTINCT FROM OLD.last_finish_reason
     OR NEW.awaiting_question IS DISTINCT FROM OLD.awaiting_question
     OR NEW.message_count IS DISTINCT FROM OLD.message_count
     OR NEW.session_input_tokens IS DISTINCT FROM OLD.session_input_tokens
     OR NEW.session_output_tokens IS DISTINCT FROM OLD.session_output_tokens
     OR NEW.session_steps IS DISTINCT FROM OLD.session_steps
     OR NEW.auto_resume_count IS DISTINCT FROM OLD.auto_resume_count THEN
    NEW.etag := uuid_generate_v4();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_sessions_regen_etag ON agent_sessions;
CREATE TRIGGER trg_agent_sessions_regen_etag
  BEFORE UPDATE ON agent_sessions
  FOR EACH ROW EXECUTE FUNCTION agent_sessions_regen_etag();

-- --------------------------------------------------------------------
-- Phase F — Cross-turn budget accumulation.
--
-- Every /api/chat turn reads these into the Budget at start and writes
-- them back at end. session_token_budget=NULL means "use env default
-- AGENT_SESSION_TOKEN_BUDGET".
-- --------------------------------------------------------------------
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS session_input_tokens  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS session_output_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS session_steps         INT    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS session_token_budget  BIGINT;

-- --------------------------------------------------------------------
-- Phase I — Auto-resume cap counter.
-- The reanimator increments this on every successful resume; the
-- /api/sessions/:id/resume route refuses once it exceeds the cap (default 10).
-- --------------------------------------------------------------------
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS auto_resume_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_resume_cap   INT NOT NULL DEFAULT 10;

-- --------------------------------------------------------------------
-- Phase E — DB-backed plans table.
--
-- Replaces the in-memory 5-min planStore. A plan belongs to exactly one
-- session (RLS via the session row). Steps are typed PlanStep[] (mirror
-- of services/agent-claw/src/core/plan-mode.ts).
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_plans (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id          UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  steps               JSONB NOT NULL,
  current_step_index  INT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'proposed'
                        CHECK (status IN (
                          'proposed', 'approved', 'running',
                          'completed', 'cancelled', 'failed'
                        )),
  -- Optional: the original system + user messages that produced this plan,
  -- so /plan/approve can re-instantiate the harness without the client
  -- having to pass them on the resume call.
  initial_messages    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_plans_session_status
  ON agent_plans(session_id, status);

DROP TRIGGER IF EXISTS trg_agent_plans_updated_at ON agent_plans;
CREATE TRIGGER trg_agent_plans_updated_at
  BEFORE UPDATE ON agent_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE agent_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_plans FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_plans_via_session_policy ON agent_plans;
CREATE POLICY agent_plans_via_session_policy ON agent_plans
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM agent_sessions s
       WHERE s.id = agent_plans.session_id
         AND s.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM agent_sessions s
       WHERE s.id = agent_plans.session_id
         AND s.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_plans TO chemclaw_app;

COMMIT;
