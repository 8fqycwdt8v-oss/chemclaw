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

-- ── mcp-doc-fetcher service (Phase B.1) ───────────────────────────────────────

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-doc-fetcher', 'http://localhost:8006', true, 'unknown')
ON CONFLICT (service_name) DO UPDATE SET
  base_url      = EXCLUDED.base_url,
  enabled       = EXCLUDED.enabled;

-- ── fetch_original_document builtin (Phase B.1) ───────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'fetch_original_document',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "document_id": {
        "type": "string",
        "format": "uuid",
        "description": "UUID of the document to retrieve."
      },
      "format": {
        "type": "string",
        "enum": ["bytes", "markdown", "pdf_pages"],
        "default": "markdown",
        "description": "Output format. markdown=parsed text (cheap), bytes=raw original file, pdf_pages=PNG renders of specified pages."
      },
      "pages": {
        "type": "array",
        "items": {"type": "integer", "minimum": 0},
        "maxItems": 50,
        "description": "0-based page indices to render. Only used when format=pdf_pages."
      }
    },
    "required": ["document_id"]
  }',
  'Retrieve a document by UUID. Use format=markdown (default) for text-only questions; format=bytes for the raw original file (PDF/DOCX/PPTX); format=pdf_pages to render specific pages as PNG images.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source       = EXCLUDED.source,
  schema_json  = EXCLUDED.schema_json,
  description  = EXCLUDED.description,
  enabled      = EXCLUDED.enabled,
  version      = EXCLUDED.version;

-- ── Phase B.2: additional MCP services ──────────────────────────────────────

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-drfp', 'http://localhost:8002', true, 'unknown')
ON CONFLICT (service_name) DO UPDATE SET
  base_url = EXCLUDED.base_url,
  enabled  = EXCLUDED.enabled;

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-embedder', 'http://localhost:8004', true, 'unknown')
ON CONFLICT (service_name) DO UPDATE SET
  base_url = EXCLUDED.base_url,
  enabled  = EXCLUDED.enabled;

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-kg', 'http://localhost:8003', true, 'unknown')
ON CONFLICT (service_name) DO UPDATE SET
  base_url = EXCLUDED.base_url,
  enabled  = EXCLUDED.enabled;

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-tabicl', 'http://localhost:8005', true, 'unknown')
ON CONFLICT (service_name) DO UPDATE SET
  base_url = EXCLUDED.base_url,
  enabled  = EXCLUDED.enabled;

-- ── find_similar_reactions ────────────────────────────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'find_similar_reactions',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "rxn_smiles": {"type": "string", "minLength": 3, "maxLength": 20000,
                     "description": "Seed reaction SMILES to find similar reactions for."},
      "k":          {"type": "number", "description": "Max results to return (1-50). Default 10."},
      "rxno_class": {"type": "string", "maxLength": 200,
                     "description": "Optional RXNO class filter."},
      "min_yield_pct": {"type": "number", "description": "Optional minimum yield % filter (0-100)."}
    },
    "required": ["rxn_smiles"]
  }',
  'Find reactions similar to a seed reaction SMILES using DRFP fingerprint cosine search. Returns up to k reactions with citations.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── search_knowledge ─────────────────────────────────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'search_knowledge',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "query":    {"type": "string", "minLength": 1, "maxLength": 4000,
                  "description": "Search query (semantic or keyword)."},
      "k":        {"type": "number", "description": "Max chunks to return (1-50). Default 10."},
      "mode":     {"type": "string", "description": "hybrid (default), dense, or sparse."},
      "source_types": {"type": "array", "items": {"type": "string"},
                       "description": "Optional source type filter list."}
    },
    "required": ["query"]
  }',
  'Hybrid dense+sparse search over ingested documents using BGE-M3 embeddings and trigram matching. Returns chunk citations.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── fetch_full_document ───────────────────────────────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'fetch_full_document',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "document_id": {"type": "string", "description": "UUID of the document to fetch."}
    },
    "required": ["document_id"]
  }',
  'Retrieve the full parsed markdown of a document by UUID. Alias for fetch_original_document(format=markdown). Use after search_knowledge to read the complete document.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── query_kg ─────────────────────────────────────────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'query_kg',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "entity": {
        "type": "object",
        "properties": {
          "label":       {"type": "string", "description": "Node label (PascalCase, e.g. Compound)."},
          "id_property": {"type": "string", "description": "Property name for the ID (snake_case)."},
          "id_value":    {"type": "string", "description": "Value of the ID property."}
        },
        "required": ["label", "id_property", "id_value"]
      },
      "predicate":         {"type": "string", "description": "Optional predicate filter (UPPER_SNAKE)."},
      "direction":         {"type": "string", "description": "in, out, or both (default both)."},
      "at_time":           {"type": "string", "description": "ISO-8601 datetime for historical query."},
      "include_invalidated": {"type": "boolean", "description": "Include invalidated facts (default false)."}
    },
    "required": ["entity"]
  }',
  'Query the bi-temporal knowledge graph for facts about an entity. Returns fact_ids tracked for anti-fabrication.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── check_contradictions ─────────────────────────────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'check_contradictions',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "entity": {
        "type": "object",
        "properties": {
          "label":       {"type": "string"},
          "id_property": {"type": "string"},
          "id_value":    {"type": "string"}
        },
        "required": ["label", "id_property", "id_value"]
      },
      "predicate": {"type": "string", "description": "Optional predicate to narrow contradiction search."}
    },
    "required": ["entity"]
  }',
  'Surface explicit CONTRADICTS edges and parallel current facts for an entity. Deep research only — does not resolve contradictions.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── draft_section ─────────────────────────────────────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'draft_section',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "heading":       {"type": "string", "minLength": 1, "maxLength": 400,
                        "description": "Section heading (H2)."},
      "evidence_refs": {"type": "array", "items": {"type": "string"},
                        "description": "Citation tokens [exp:...] [rxn:...] [proj:...] [doc:...] [kg:...] [unsourced]."},
      "body_markdown": {"type": "string", "minLength": 1, "maxLength": 40000,
                        "description": "Section body markdown with inline citation tokens."}
    },
    "required": ["heading", "evidence_refs", "body_markdown"]
  }',
  'Compose and validate a report section. Returns formatted markdown with audit trail of declared vs used citations.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── mark_research_done ───────────────────────────────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'mark_research_done',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "title":             {"type": "string", "minLength": 1, "maxLength": 400},
      "executive_summary": {"type": "string", "minLength": 1, "maxLength": 8000},
      "sections": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "heading":       {"type": "string"},
            "body_markdown": {"type": "string"}
          },
          "required": ["heading", "body_markdown"]
        }
      },
      "open_questions":  {"type": "array", "items": {"type": "string"}},
      "contradictions":  {"type": "array", "items": {"type": "string"}},
      "citations": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "ref":    {"type": "string"},
            "detail": {"type": "string"}
          },
          "required": ["ref"]
        }
      }
    },
    "required": ["title", "executive_summary", "sections"]
  }',
  'TERMINAL. Assemble and persist the deep research report to research_reports. Returns report_id and slug.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── expand_reaction_context ──────────────────────────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'expand_reaction_context',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "reaction_id": {"type": "string", "description": "UUID of the reaction to expand."},
      "include": {
        "type": "array",
        "items": {"type": "string"},
        "description": "Subsections to include: reagents, conditions, outcomes, failures, citations, predecessors."
      },
      "hop_limit": {"type": "number", "description": "1 or 2. hop_limit=2 enables predecessor lookup."}
    },
    "required": ["reaction_id"]
  }',
  'Expand a reaction with full context including reagents, conditions, outcomes, failures, and citations. Returns surfaced_fact_ids for anti-fabrication tracking.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── statistical_analyze ──────────────────────────────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'statistical_analyze',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "reaction_ids": {
        "type": "array",
        "items": {"type": "string"},
        "description": "List of reaction UUIDs (5-500)."
      },
      "question": {
        "type": "string",
        "description": "predict_yield_for_similar | rank_feature_importance | compare_conditions"
      },
      "query_reaction_ids": {
        "type": "array",
        "items": {"type": "string"},
        "description": "Required for predict_yield_for_similar. Reaction UUIDs to predict yield for."
      }
    },
    "required": ["reaction_ids", "question"]
  }',
  'Statistical analysis on a reaction set. compare_conditions: SQL bucket aggregation. predict_yield_for_similar: TabICL regression. rank_feature_importance: TabICL permutation importance.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── synthesize_insights ──────────────────────────────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'synthesize_insights',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "reaction_set": {
        "type": "array",
        "items": {"type": "string"},
        "description": "Reaction UUIDs to synthesize insights from (3-500)."
      },
      "question": {
        "type": "string",
        "minLength": 20,
        "maxLength": 2000,
        "description": "The research question to answer with structured insights."
      },
      "prior_stats": {
        "type": "object",
        "description": "Optional prior statistical analysis result to include in context."
      }
    },
    "required": ["reaction_set", "question"]
  }',
  'LLM-based structured insight synthesis over a reaction set. Drops insights citing unseen fact_ids (anti-fabrication soft guard).',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── propose_hypothesis ───────────────────────────────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'propose_hypothesis',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "hypothesis_text": {
        "type": "string",
        "minLength": 10,
        "maxLength": 4000,
        "description": "The hypothesis statement."
      },
      "cited_fact_ids": {
        "type": "array",
        "items": {"type": "string"},
        "description": "Fact UUIDs from KG that support the hypothesis (must be seen this turn)."
      },
      "cited_reaction_ids": {
        "type": "array",
        "items": {"type": "string"},
        "description": "Optional reaction UUIDs supporting the hypothesis."
      },
      "confidence": {
        "type": "number",
        "description": "Confidence score 0-1."
      },
      "scope_nce_project_id": {
        "type": "string",
        "description": "Optional NCE project UUID to scope the hypothesis."
      },
      "citation_notes": {
        "type": "object",
        "description": "Optional map of fact_id -> note string."
      }
    },
    "required": ["hypothesis_text", "cited_fact_ids", "confidence"]
  }',
  'Persist a hypothesis backed by cited KG fact_ids seen this turn. Hard-rejects unseen fact_ids (anti-fabrication guard). Emits hypothesis_proposed event.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

COMMIT;
