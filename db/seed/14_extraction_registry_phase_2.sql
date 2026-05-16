-- db/seed/14_extraction_registry_phase_2.sql
--
-- Universal Knowledge Accumulation — Phase 2 ELN/LOGS extractors.
--
-- Registers extractors for mcp_eln_local builtins (query_eln_canonical_reactions,
-- query_eln_experiments, query_eln_samples_by_entry, query_eln_entries_by_experiment)
-- and mcp_logs_sciy builtins (query_hplc_datasets, query_nmr_datasets,
-- query_ms_datasets).
--
-- source_kind 'mcp_tool' matches the tool-invocation-emitter hook's event
-- payload. source_name matches the agent-claw builtin id. result_schema_id
-- is "<response_root_key>.v1".

BEGIN;

INSERT INTO extraction_registry (
  source_kind, source_name, result_schema_id, extractor_module,
  enabled, promote_default
) VALUES
  -- ELN canonical reactions (OFAT-collapsed): yield%, temperature, ofat_count
  -- scoped to Compound (SMILES). First 5 reactions only to avoid volume flooding.
  ('mcp_tool', 'query_eln_canonical_reactions', 'eln_reactions.v1',
   'services.projectors.fact_extractor.eln_reaction', TRUE, TRUE),

  -- ELN experiment metadata: experiment type, status, entry count
  -- scoped to NCEProject.
  ('mcp_tool', 'query_eln_experiments', 'eln_experiments.v1',
   'services.projectors.fact_extractor.eln_experiment', TRUE, TRUE),

  -- ELN sample purity from analytical measurements attached to ELN entries.
  -- High-confidence analytical measurement; compound identified by inchikey.
  ('mcp_tool', 'query_eln_samples_by_entry', 'eln_samples.v1',
   'services.projectors.fact_extractor.eln_sample', TRUE, TRUE),

  -- ELN free-text entries: records EXISTENCE of a note only, never the body.
  -- The note body may contain sensitive chemistry not yet redacted.
  ('mcp_tool', 'query_eln_entries_by_experiment', 'eln_entries.v1',
   'services.projectors.fact_extractor.eln_entry', TRUE, TRUE),

  -- LOGS-by-SciY HPLC datasets: purity%, peak count, main peak RT.
  -- First 3 datasets per call; compound_smiles preferred, ctx.args fallback.
  ('mcp_tool', 'query_hplc_datasets', 'hplc_datasets.v1',
   'services.projectors.fact_extractor.hplc', TRUE, TRUE),

  -- LOGS-by-SciY NMR datasets: shift count (from field or len(shifts_ppm)).
  ('mcp_tool', 'query_nmr_datasets', 'nmr_datasets.v1',
   'services.projectors.fact_extractor.nmr', TRUE, TRUE),

  -- LOGS-by-SciY MS datasets: precursor m/z (>0 guard), peak count.
  ('mcp_tool', 'query_ms_datasets', 'ms_datasets.v1',
   'services.projectors.fact_extractor.ms', TRUE, TRUE)

ON CONFLICT (source_kind, source_name, result_schema_id) DO UPDATE SET
  extractor_module = EXCLUDED.extractor_module,
  enabled          = EXCLUDED.enabled,
  promote_default  = EXCLUDED.promote_default,
  updated_at       = NOW();

COMMIT;
