-- db/init/63_extraction_registry.sql
--
-- Universal Knowledge Accumulation — Phase 0
-- Dispatch table: maps (source_kind, source_name, result_schema_id) to the
-- Python module that implements `extract(result, ctx) -> list[FactDraft]`.
-- Phase 1+ populates rows here via db/seed/. `promote_default=false` for
-- volume-bombing sources (genchem); the agent can still force-promote via
-- the per-call `promote_to_kg=true` flag.

BEGIN;

CREATE TABLE IF NOT EXISTS extraction_registry (
  source_kind       TEXT NOT NULL
                    CHECK (source_kind IN ('mcp_tool', 'ingestion', 'workflow', 'external')),
  source_name       TEXT NOT NULL,
  result_schema_id  TEXT NOT NULL,
  extractor_module  TEXT NOT NULL,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  promote_default   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_kind, source_name, result_schema_id)
);

COMMENT ON TABLE extraction_registry IS
  'Dispatch table for the tool_result_extractor projector. Adding KG support '
  'for a new source = (1) write extract() in a Python module, (2) INSERT a '
  'row here. No code change in the projector itself.';

-- Global read; chemclaw_service write. No RLS — registry is metadata.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT ON extraction_registry TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON extraction_registry TO chemclaw_service;
  END IF;
END $$;

INSERT INTO schema_version (filename, applied_at)
VALUES ('63_extraction_registry.sql', NOW())
ON CONFLICT (filename) DO NOTHING;

COMMIT;
