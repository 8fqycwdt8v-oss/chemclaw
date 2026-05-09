-- Phase E correction — link feedback_events to the prompt being rated.
BEGIN;
ALTER TABLE feedback_events
  ADD COLUMN IF NOT EXISTS prompt_name TEXT,
  ADD COLUMN IF NOT EXISTS prompt_version INT;
CREATE INDEX IF NOT EXISTS idx_feedback_prompt_created
  ON feedback_events (prompt_name, created_at DESC)
  WHERE prompt_name IS NOT NULL;

-- Self-record for schema_version (Makefile loop is belt-and-suspenders).
INSERT INTO schema_version (filename)
VALUES ('15_feedback_prompt_link.sql')
ON CONFLICT DO NOTHING;
COMMIT;
