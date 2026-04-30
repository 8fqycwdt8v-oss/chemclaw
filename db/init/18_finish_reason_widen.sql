-- Cycle-2 review: widen agent_sessions.last_finish_reason CHECK to match the
-- TS SessionFinishReason union (services/agent-claw/src/core/session-store.ts).
--
-- The original CHECK in 16_db_audit_fixes.sql allowed only 5 values:
--   stop, max_steps, budget_exceeded, awaiting_user_input, error
--
-- Application code has since written four more terminal reasons through
-- persistTurnState:
--   session_budget_exceeded (PR-8 era — chat.ts catch arm)
--   concurrent_modification (PR-8 era — chat.ts catch arm)
--   cancelled               (PR #56 — streaming-error helper)
--   plan_ready              (PR #56 — streaming plan-mode helper)
--
-- Postgres rejected those with check_violation (23514) and the route's
-- outer-finally try/catch swallowed the error as a warn-log line —
-- scratchpad / etag / token totals / awaiting_question were silently
-- dropping for those terminal paths. This migration widens the CHECK so
-- those writes succeed.
--
-- Re-applicable: drops the old constraint by name (if present) before
-- re-adding the wider one.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.agent_sessions') IS NOT NULL THEN
    -- Drop the narrow constraint added in 16_db_audit_fixes.sql.
    IF EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname  = 'agent_sessions_finish_reason_check'
         AND conrelid = 'agent_sessions'::regclass
    ) THEN
      ALTER TABLE agent_sessions
        DROP CONSTRAINT agent_sessions_finish_reason_check;
    END IF;

    -- Re-add with the wider TS-aligned set.
    ALTER TABLE agent_sessions
      ADD CONSTRAINT agent_sessions_finish_reason_check
      CHECK (last_finish_reason IS NULL OR last_finish_reason IN (
        'stop',
        'max_steps',
        'budget_exceeded',
        'session_budget_exceeded',
        'awaiting_user_input',
        'concurrent_modification',
        'cancelled',
        'plan_ready',
        'error'
      ));
  END IF;
END $$;

COMMIT;
