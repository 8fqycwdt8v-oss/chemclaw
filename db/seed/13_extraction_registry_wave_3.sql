-- db/seed/13_extraction_registry_wave_3.sql
--
-- Universal Knowledge Accumulation — Phase 1 wave 3.
--
-- Registers extractors for askcos (query_conditions), ord_io
-- (query_ord_reactions), plate_designer (design_plate), chrom_method
-- (optimize_chromatography_method), bo_round (recommend_next_batch +
-- ingest_campaign_results), and reaction_optimizer (start_optimization_campaign
-- + extract_pareto_front).
--
-- source_name matches the agent-claw builtin id registered in
-- bootstrap/dependencies.ts. result_schema_id is "<endpoint>.v1".

BEGIN;

INSERT INTO extraction_registry (
  source_kind, source_name, result_schema_id, extractor_module,
  enabled, promote_default
) VALUES
  -- askcos forward condition prediction: ranked list of predicted reaction
  -- conditions. Emits condition count + top score per invocation.
  ('mcp_tool', 'query_conditions', 'conditions.v1',
   'services.projectors.fact_extractor.askcos', TRUE, TRUE),

  -- ORD (Open Reaction Database): experimentally measured reaction records.
  -- High-confidence source; emit yield% + temperature for first record only.
  ('mcp_tool', 'query_ord_reactions', 'ord_reactions.v1',
   'services.projectors.fact_extractor.ord_io', TRUE, TRUE),

  -- plate designer: campaign-level plate layout decisions.
  -- Emits well count + design strategy scoped to NCEProject.
  ('mcp_tool', 'design_plate', 'plate_design.v1',
   'services.projectors.fact_extractor.plate_designer', TRUE, TRUE),

  -- chromatography method optimizer: BO Pareto front of HPLC conditions.
  -- Emits pareto front size + best resolution scoped to NCEProject.
  ('mcp_tool', 'optimize_chromatography_method', 'chrom_pareto.v1',
   'services.projectors.fact_extractor.chrom_method', TRUE, TRUE),

  -- BO recommend_next_batch: suggestion count + round index.
  -- Same module handles both BO builtins via response-shape discrimination.
  ('mcp_tool', 'recommend_next_batch', 'bo_suggest.v1',
   'services.projectors.fact_extractor.bo_round', TRUE, TRUE),

  -- BO ingest_campaign_results: observed yield mean + round index.
  ('mcp_tool', 'ingest_campaign_results', 'bo_observe.v1',
   'services.projectors.fact_extractor.bo_round', TRUE, TRUE),

  -- optimization campaign lifecycle: objective count at campaign start.
  ('mcp_tool', 'start_optimization_campaign', 'opt_start.v1',
   'services.projectors.fact_extractor.reaction_optimizer', TRUE, TRUE),

  -- optimization campaign lifecycle: Pareto front size + best yield.
  ('mcp_tool', 'extract_pareto_front', 'pareto.v1',
   'services.projectors.fact_extractor.reaction_optimizer', TRUE, TRUE)

ON CONFLICT (source_kind, source_name, result_schema_id) DO UPDATE SET
  extractor_module = EXCLUDED.extractor_module,
  enabled          = EXCLUDED.enabled,
  promote_default  = EXCLUDED.promote_default,
  updated_at       = NOW();

COMMIT;
