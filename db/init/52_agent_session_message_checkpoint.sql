-- Phase B2 — message history checkpoint.
--
-- Pre-fix the harness held the active Message[] array in process memory only.
-- A process restart mid-chain (deploy, OOM, container reschedule) destroyed
-- the transcript: the next reanimator tick reloaded the session row, found a
-- non-zero message_count but no body, and re-entered the loop with a single
-- "Continue from the last step." synthetic user message. The model lost all
-- context — every prior tool result, every reasoning step, every citation
-- it had built up. Long autonomous runs that crossed any restart boundary
-- effectively reset.
--
-- This adds a JSONB column to capture the active message history at every
-- persistTurnState call, so reanimator can rehydrate the model's working
-- context. We compress nothing here — the redactor already runs upstream
-- and the rows are bounded by AGENT_CHAT_MAX_HISTORY (default 40).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); follows the pattern in
-- 14_agent_session_extensions.sql.

BEGIN;

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS messages_checkpoint JSONB;

-- Include messages_checkpoint in the etag-regen trigger so a checkpoint
-- write also bumps the etag. Without this, two writers could race —
-- writer A persists a checkpoint at message_count=40, writer B simul-
-- writes at message_count=41 with a stale etag, B wins, A's checkpoint
-- is silently overwritten. The check on `messages_checkpoint IS DISTINCT
-- FROM` covers null→jsonb and jsonb→jsonb transitions equally.
CREATE OR REPLACE FUNCTION agent_sessions_regen_etag()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.scratchpad IS DISTINCT FROM OLD.scratchpad
     OR NEW.last_finish_reason IS DISTINCT FROM OLD.last_finish_reason
     OR NEW.awaiting_question IS DISTINCT FROM OLD.awaiting_question
     OR NEW.message_count IS DISTINCT FROM OLD.message_count
     OR NEW.session_input_tokens IS DISTINCT FROM OLD.session_input_tokens
     OR NEW.session_output_tokens IS DISTINCT FROM OLD.session_output_tokens
     OR NEW.session_steps IS DISTINCT FROM OLD.session_steps
     OR NEW.auto_resume_count IS DISTINCT FROM OLD.auto_resume_count
     OR NEW.messages_checkpoint IS DISTINCT FROM OLD.messages_checkpoint THEN
    NEW.etag := uuid_generate_v4();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
