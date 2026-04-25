-- Phase E: Self-improvement loop — shadow serving, GEPA metadata, skill promotion events.
-- Idempotent: all changes use IF NOT EXISTS / DO $$ blocks.

BEGIN;

-- ============================================================
-- 1. Extend prompt_registry for shadow serving + GEPA metadata
-- ============================================================

ALTER TABLE prompt_registry
  ADD COLUMN IF NOT EXISTS shadow_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gepa_metadata JSONB;

-- ============================================================
-- 2. Shadow run scores
-- ============================================================

CREATE TABLE IF NOT EXISTS shadow_run_scores (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  prompt_name     text NOT NULL,
  version         int  NOT NULL,
  trace_id        text,
  score           float8 NOT NULL,
  per_class_scores jsonb,
  run_at          timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shadow_run_scores_prompt
  ON shadow_run_scores(prompt_name, version, run_at DESC);

-- RLS
ALTER TABLE shadow_run_scores ENABLE ROW LEVEL SECURITY;

-- Internal / service reads: bypass RLS as chemclaw_service role is BYPASSRLS.
-- User-facing reads: no user-scoped data here; allow reads for any authenticated user.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename='shadow_run_scores' AND policyname='shadow_run_scores_read'
  ) THEN
    CREATE POLICY shadow_run_scores_read ON shadow_run_scores FOR SELECT USING (true);
  END IF;
END $$;

-- ============================================================
-- 3. Skill promotion events
-- ============================================================

CREATE TABLE IF NOT EXISTS skill_promotion_events (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  skill_name  text NOT NULL,
  version     int  NOT NULL,
  event_type  text NOT NULL
    CHECK (event_type IN ('promote','demote','shadow_start','shadow_promote','shadow_reject')),
  reason      text,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_skill_promotion_events_name
  ON skill_promotion_events(skill_name, created_at DESC);

ALTER TABLE skill_promotion_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename='skill_promotion_events' AND policyname='skill_promotion_events_read'
  ) THEN
    CREATE POLICY skill_promotion_events_read ON skill_promotion_events FOR SELECT USING (true);
  END IF;
END $$;

-- ============================================================
-- 4. Extend forged_tool_validation_runs for skill promoter
-- ============================================================

-- The skill promoter reads success_count / total_runs from skill_library
-- (already has those columns from 06_skill_library.sql).
-- No extra columns needed; the promoter aggregates forged_tool_validation_runs
-- for forged tools and skill_library.success_count for prompt skills.

COMMIT;
