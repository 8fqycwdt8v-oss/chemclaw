-- db/seed/10_extraction_registry_xtb.sql
--
-- Universal Knowledge Accumulation — Phase 1.1 pilot.
--
-- Registers the xtb single_point extractor. Phase 0 shipped the
-- extraction_registry table empty; this is the first row, exercising
-- the registry-driven dispatch in tool_result_extractor end-to-end.
--
-- The (source_kind, source_name, result_schema_id) tuple is the
-- composite PK; promote_default=TRUE because xtb results are typed +
-- deterministic and the volume is bounded by actual chemistry queries.

BEGIN;

INSERT INTO extraction_registry (
  source_kind,
  source_name,
  result_schema_id,
  extractor_module,
  enabled,
  promote_default
) VALUES (
  'mcp_tool',
  'qm_single_point',
  'single_point.v1',
  'services.projectors.fact_extractor.xtb',
  TRUE,
  TRUE
)
ON CONFLICT (source_kind, source_name, result_schema_id) DO UPDATE SET
  extractor_module = EXCLUDED.extractor_module,
  enabled          = EXCLUDED.enabled,
  promote_default  = EXCLUDED.promote_default,
  updated_at       = NOW();

COMMIT;
