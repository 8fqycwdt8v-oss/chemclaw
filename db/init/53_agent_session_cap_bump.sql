-- Phase B3 — raise auto_resume_cap default from 10 → 30.
--
-- The original default (10) capped a session's lifetime autonomous progress
-- at ~50 minutes (10 resumes × 5-minute reanimator poll). For long-running
-- synthesis-planning tasks this trips well before useful completion.
-- Raising to 30 gives ~150 minutes of unattended progress; combined with
-- the AGENT_PLAN_MAX_AUTO_TURNS bump (10 → 40) and the wall-clock cap
-- (per-turn 30 min), this keeps the harness honest while letting it
-- actually finish multi-hour work.
--
-- Existing rows: bump only those still at the legacy default (10) so
-- operators who have explicitly set a custom cap (lower or higher) keep
-- their override. Idempotent; safe to rerun.

BEGIN;

ALTER TABLE agent_sessions
  ALTER COLUMN auto_resume_cap SET DEFAULT 30;

UPDATE agent_sessions
   SET auto_resume_cap = 30
 WHERE auto_resume_cap = 10;
-- Self-record for schema_version (Makefile loop is belt-and-suspenders).
INSERT INTO schema_version (filename, applied_at)
  VALUES ('53_agent_session_cap_bump.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
