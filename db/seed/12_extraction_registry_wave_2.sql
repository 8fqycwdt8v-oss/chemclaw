-- db/seed/12_extraction_registry_wave_2.sql
--
-- Universal Knowledge Accumulation — Phase 1.2 wave-2.
--
-- Registers extractors for sirius, crest, synthegy, tabicl, genchem.
-- Each row points (source_kind, source_name, result_schema_id) at the
-- extractor module — the dispatching projector (tool_result_extractor)
-- handles the rest.
--
-- The source_name here matches the agent-claw builtin id that wraps the
-- MCP endpoint. result_schema_id is conventionally "<endpoint>.v1".
--
-- genchem rows get `promote_default=FALSE` (load-bearing). A single
-- generate_focused_library call can produce 5000+ candidate molecules;
-- staging the fact until an admin or downstream scorer promotes it is the
-- volume-bombing safety net per CLAUDE.md / extractor-pattern spec.

BEGIN;

INSERT INTO extraction_registry (
  source_kind, source_name, result_schema_id, extractor_module,
  enabled, promote_default
) VALUES
  -- sirius MS structure identification: top-N candidate SMILES with CSI:FingerID
  -- scores. Capped at 5 candidates per spectrum in the extractor.
  ('mcp_tool', 'identify_unknown_from_ms', 'identify.v1',
   'services.projectors.fact_extractor.sirius', TRUE, TRUE),

  -- crest conformer / tautomer / protomer ensemble: per-compound rollup
  -- facts (count + lowest energy). One builtin covers all three modes via
  -- the `task` field in the response.
  ('mcp_tool', 'qm_crest_screen', 'crest_ensemble.v1',
   'services.projectors.fact_extractor.crest', TRUE, TRUE),

  -- synthegy mechanism elucidation: per-reaction rollup (step count + top
  -- barrier in kJ/mol when energy validation populated deltas).
  ('mcp_tool', 'elucidate_mechanism', 'elucidate_mechanism.v1',
   'services.projectors.fact_extractor.synthegy', TRUE, TRUE),

  -- tabicl (TabPFN) predict_yield_for_similar: per-reaction calibrated
  -- yield prediction with std-modulated confidence. Wrapped via the
  -- statistical_analyze builtin.
  ('mcp_tool', 'statistical_analyze', 'predict_yield_for_similar.v1',
   'services.projectors.fact_extractor.tabicl', TRUE, TRUE),

  -- genchem generative chemistry: per-run rollup ONLY (one fact per
  -- generate_focused_library call, NOT per candidate molecule). The
  -- per-candidate explosion would flood the KG; the run_id + candidate_count
  -- is the right granularity for the wiki layer to summarise.
  -- promote_default=FALSE — exploratory tier, must be promoted explicitly.
  ('mcp_tool', 'generate_focused_library', 'gen_run.v1',
   'services.projectors.fact_extractor.genchem', TRUE, FALSE)
ON CONFLICT (source_kind, source_name, result_schema_id) DO UPDATE SET
  extractor_module = EXCLUDED.extractor_module,
  enabled          = EXCLUDED.enabled,
  promote_default  = EXCLUDED.promote_default,
  updated_at       = NOW();

COMMIT;
