-- db/seed/11_extraction_registry_wave_1.sql
--
-- Universal Knowledge Accumulation — Phase 1.2 wave-1.
--
-- Registers extractors for aizynth, chemprop, applicability_domain,
-- yield_baseline. Each row points (source_kind, source_name, result_schema_id)
-- at the extractor module — the dispatching projector
-- (tool_result_extractor) handles the rest.
--
-- The agent builtins (qm_single_point, etc.) call the corresponding MCP
-- endpoints; the source_name here matches the builtin name registered in
-- bootstrap/dependencies.ts. result_schema_id versioning is by convention
-- "<endpoint>.v1" — bump when the response shape changes incompatibly.

BEGIN;

-- Remove stale rows from earlier seed runs that used incorrect source_name
-- values before the builtin-name alignment was corrected. ON CONFLICT only
-- upserts exact-key matches, so misnamed rows must be deleted explicitly.
DELETE FROM extraction_registry
 WHERE source_kind = 'mcp_tool'
   AND source_name IN (
     'aizynth_retrosynthesis',   -- was propose_retrosynthesis
     'predict_property',         -- was predict_molecular_property
     'train_yield_baseline'      -- was predict_yield_with_uq
   );

INSERT INTO extraction_registry (
  source_kind, source_name, result_schema_id, extractor_module,
  enabled, promote_default
) VALUES
  -- aizynth retrosynthesis: per-target rollup (top score + in-stock ratio
  -- + route count). source_name = builtin registered in bootstrap/dependencies.ts.
  ('mcp_tool', 'propose_retrosynthesis', 'retrosynthesis.v1',
   'services.projectors.fact_extractor.aizynth', TRUE, TRUE),

  -- chemprop predict_yield: per-reaction calibrated yield prediction.
  ('mcp_tool', 'predict_reaction_yield', 'predict_yield.v1',
   'services.projectors.fact_extractor.chemprop', TRUE, TRUE),

  -- chemprop predict_molecular_property: per-compound property (logP, logS,
  -- mp, bp). Same module dispatches on response shape.
  ('mcp_tool', 'predict_molecular_property', 'predict_property.v1',
   'services.projectors.fact_extractor.chemprop', TRUE, TRUE),

  -- applicability_domain assess: in/out-of-domain verdict + signal scores.
  ('mcp_tool', 'assess_applicability_domain', 'assess.v1',
   'services.projectors.fact_extractor.applicability_domain', TRUE, TRUE),

  -- yield_baseline: baseline-model training events extracted from the
  -- predict_yield_with_uq builtin output (carries model_id + n_train).
  ('mcp_tool', 'predict_yield_with_uq', 'train.v1',
   'services.projectors.fact_extractor.yield_baseline', TRUE, TRUE)
ON CONFLICT (source_kind, source_name, result_schema_id) DO UPDATE SET
  extractor_module = EXCLUDED.extractor_module,
  enabled          = EXCLUDED.enabled,
  promote_default  = EXCLUDED.promote_default,
  updated_at       = NOW();

COMMIT;
