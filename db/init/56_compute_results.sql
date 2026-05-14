-- Compute-results canonical store + `compute_result_observed` event
-- (ab-initio-tools-deep-review §3.2 / §3.6 / recommendation #1).
--
-- Schema-choice rationale (recorded here so the PR description and this
-- migration agree forever):
--
-- The review's recommendation #1 offered three persistence options for
-- chemistry-prediction-tool output (askcos / aizynth / chemprop /
-- synthegy_mech / sirius / …):
--   (a) leave ephemeral
--   (b) typed per-domain tables (predicted_reactions / predicted_properties)
--   (c) one generic compute_results table keyed by (tool_id, input_hash),
--       analogous to qm_jobs
--
-- This PR takes (c)-leaning: a single generic store. Reasons:
--   * mirrors the qm_jobs pattern the review explicitly held up as the
--     model, so the agent-side mental model stays uniform across DFT and
--     ML predictors;
--   * dedup / cache hit for free via the UNIQUE (tool_id, input_hash,
--     nce_project_id, model_id) cache key — "use the route we found
--     yesterday" is a SELECT, not a fresh tool call;
--   * does not require a new migration every time a chemistry MCP is added.
--
-- The follow-up to materialise predicted *reaction steps* into `reactions`
-- (using the is_predicted discriminator landed in PR #160 / db/init/55_*)
-- is a separate PR because it needs (i) relaxation of
-- `reactions.experiment_id NOT NULL` and (ii) an RLS rule for orphan
-- predicted rows. That decision is intentionally NOT bundled here.
--
-- This migration is the minimum viable canonical store:
--   * table + RLS + indexes + UNIQUE cache key
--   * INSERT trigger that emits a compute_result_observed event
--   * catalog row registering the event type
--
-- A writer (post_tool hook that records the row on every chemistry-tool
-- return) is the NEXT PR. Without a writer, the table is unused but ready;
-- replay safety is preserved because no projector is wired yet.
--
-- Idempotent.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Canonical store
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS compute_results (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Cache key. input_hash is a canonicalised-input SHA-256 hex (the writer
  -- in the next PR will compute this from normalised tool inputs).
  -- model_id NOT NULL DEFAULT '' (instead of nullable) so the UNIQUE
  -- constraint is a plain composite and ON CONFLICT clauses elsewhere
  -- don't need expression-index gymnastics.
  tool_id                     TEXT NOT NULL,
  input_hash                  TEXT NOT NULL
                                CHECK (length(input_hash) BETWEEN 8 AND 128),
  model_id                    TEXT NOT NULL DEFAULT '',

  -- Project scope (required). Cross-project sharing of public-corpus
  -- predictions is a deliberate later decision — every prediction is
  -- project-scoped today, mirroring the existing repo convention.
  nce_project_id              UUID NOT NULL
                                REFERENCES nce_projects(id) ON DELETE CASCADE,

  -- Result payload. Tool-specific shape; validated by the chemistry MCP,
  -- not the DB. JSONB so projectors can index into it.
  payload                     JSONB NOT NULL,

  -- Optional tool-reported uncertainty in [0,1]. Separate from the
  -- confidence_ensemble verdict (which is the agent's bundle), this is
  -- the raw tool number — chemprop std, askcos retrosim score, …
  tool_confidence             NUMERIC(4,3)
                                CHECK (tool_confidence IS NULL OR
                                       (tool_confidence >= 0.000 AND
                                        tool_confidence <= 1.000)),

  -- Provenance.
  agent_trace_id              TEXT,
  created_by_user_entra_id    TEXT NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Bi-temporal (matching synthesis_campaigns; valid_to NULL ⇒ current).
  valid_from                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to                    TIMESTAMPTZ,

  CONSTRAINT compute_results_cache_key
    UNIQUE (tool_id, input_hash, nce_project_id, model_id)
);

-- Hot-path lookup: "freshest current result for (tool, input) in project".
CREATE INDEX IF NOT EXISTS idx_compute_results_lookup
  ON compute_results (tool_id, input_hash, nce_project_id, created_at DESC)
  WHERE valid_to IS NULL;

-- "All predictions for project X recently".
CREATE INDEX IF NOT EXISTS idx_compute_results_project_recent
  ON compute_results (nce_project_id, created_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Row-Level Security (mirrors synthesis_campaigns)
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE compute_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE compute_results FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS compute_results_user_access ON compute_results;
CREATE POLICY compute_results_user_access ON compute_results
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM user_project_access upa
     WHERE upa.nce_project_id = compute_results.nce_project_id
       AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM user_project_access upa
     WHERE upa.nce_project_id = compute_results.nce_project_id
       AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
  ));

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Ingestion event emission
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION emit_compute_result_event()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
    VALUES (
      'compute_result_observed',
      'compute_results',
      NEW.id,
      jsonb_build_object(
        'compute_result_id',        NEW.id::text,
        'tool_id',                  NEW.tool_id,
        'input_hash',               NEW.input_hash,
        'model_id',                 NEW.model_id,
        'nce_project_id',           NEW.nce_project_id::text,
        'created_by_user_entra_id', NEW.created_by_user_entra_id
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS trg_compute_result_event ON compute_results;
CREATE TRIGGER trg_compute_result_event
  AFTER INSERT ON compute_results
  FOR EACH ROW EXECUTE FUNCTION emit_compute_result_event();

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Register the new event type
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO ingestion_event_catalog (event_type, description, emitted_by, consumed_by) VALUES
  ('compute_result_observed',
   'A chemistry prediction tool (askcos / aizynth / chemprop / synthegy_mech / '
   'sirius / xtb / …) returned a result that was persisted to compute_results. '
   'Payload schema is tool-specific. As of this migration there is no consumer '
   'projector; KG fan-out is the next PR.',
   'db/init/56_compute_results.sql (trigger trg_compute_result_event)',
   ARRAY[]::TEXT[])
ON CONFLICT (event_type) DO UPDATE SET
  description = EXCLUDED.description,
  emitted_by  = EXCLUDED.emitted_by,
  consumed_by = EXCLUDED.consumed_by;
-- Self-record for schema_version (Makefile loop is belt-and-suspenders).
INSERT INTO schema_version (filename, applied_at)
  VALUES ('56_compute_results.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
