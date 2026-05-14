-- Reactions: is_predicted discriminator
-- (ab-initio-tools-deep-review §3.6 / recommendation #1 — structural prep).
--
-- Adds `is_predicted` + `predictor_tool_id` + `predictor_model_id` to
-- `reactions` so a future write path from chemistry-prediction tools
-- (askcos / aizynth / chemprop / synthegy_mech / sirius) can be distinguished
-- from ELN-observed reactions without overloading `confidence_tier`. The
-- review noted that without a discriminator, `multi_source_llm` would
-- silently broaden to mean "ML retrosynthesis prediction OR LLM extraction
-- from a paper" once any predictor wrote into `reactions`.
--
-- Today no production code inserts new rows with `is_predicted = TRUE`. The
-- existing `experiment_id NOT NULL` FK still blocks predicted writes; that
-- decision (and the `compute_result_observed` event + canonical store
-- design) is the next PR. This file is structural prep only.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS on the three columns; the CHECK
-- constraint is gated on a `pg_constraint` existence check (PostgreSQL has
-- no `ADD CONSTRAINT IF NOT EXISTS` for CHECK).

BEGIN;

ALTER TABLE reactions
  ADD COLUMN IF NOT EXISTS is_predicted        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS predictor_tool_id   TEXT,
  ADD COLUMN IF NOT EXISTS predictor_model_id  TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reactions_predicted_tool_match'
  ) THEN
    ALTER TABLE reactions
      ADD CONSTRAINT reactions_predicted_tool_match
        CHECK (
          (is_predicted = FALSE
            AND predictor_tool_id IS NULL
            AND predictor_model_id IS NULL)
          OR
          (is_predicted = TRUE AND predictor_tool_id IS NOT NULL)
        );
  END IF;
END $$;

-- Partial index for the typical "show me what tool X predicted recently"
-- read path; non-predicted rows (the overwhelming majority pre-#6) are
-- excluded so the index stays small.
CREATE INDEX IF NOT EXISTS idx_reactions_predicted
  ON reactions (predictor_tool_id, created_at DESC)
  WHERE is_predicted = TRUE;
-- Self-record for schema_version (Makefile loop is belt-and-suspenders).
INSERT INTO schema_version (filename, applied_at)
  VALUES ('55_reactions_predicted_discriminator.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
