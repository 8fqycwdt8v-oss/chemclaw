-- Phase A.2: seed harness tools catalog.
-- Registers the mcp-rdkit service and the canonicalize_smiles builtin tool.
-- UPSERT pattern: safe to re-run.

BEGIN;

-- ── MCP services ─────────────────────────────────────────────────────────────

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-rdkit', 'http://localhost:8001', true, 'unknown')
ON CONFLICT (service_name) DO UPDATE SET
  base_url      = EXCLUDED.base_url,
  enabled       = EXCLUDED.enabled;

-- ── Builtin tools ─────────────────────────────────────────────────────────────
-- canonicalize_smiles is registered as 'builtin' source; the in-process impl
-- calls mcp-rdkit via McpClient. The schema_json describes the input shape.

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'canonicalize_smiles',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "smiles": {
        "type": "string",
        "description": "SMILES string to canonicalize (max 10000 chars).",
        "minLength": 1,
        "maxLength": 10000
      },
      "kekulize": {
        "type": "boolean",
        "description": "If true, return Kekulé form without aromatic bonds."
      }
    },
    "required": ["smiles"]
  }',
  'Canonicalize a SMILES string via RDKit and return canonical_smiles, InChIKey, molecular formula, and molecular weight.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source       = EXCLUDED.source,
  schema_json  = EXCLUDED.schema_json,
  description  = EXCLUDED.description,
  enabled      = EXCLUDED.enabled,
  version      = EXCLUDED.version;

COMMIT;
