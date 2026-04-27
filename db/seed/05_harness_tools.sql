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

-- ── Phase F.1: Chemistry MCP services ────────────────────────────────────────

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-askcos', 'http://localhost:8007', true, 'unknown')
ON CONFLICT (service_name) DO UPDATE SET
  base_url = EXCLUDED.base_url,
  enabled  = EXCLUDED.enabled;

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-aizynth', 'http://localhost:8008', true, 'unknown')
ON CONFLICT (service_name) DO UPDATE SET
  base_url = EXCLUDED.base_url,
  enabled  = EXCLUDED.enabled;

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-chemprop', 'http://localhost:8009', true, 'unknown')
ON CONFLICT (service_name) DO UPDATE SET
  base_url = EXCLUDED.base_url,
  enabled  = EXCLUDED.enabled;

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-xtb', 'http://localhost:8010', true, 'unknown')
ON CONFLICT (service_name) DO UPDATE SET
  base_url = EXCLUDED.base_url,
  enabled  = EXCLUDED.enabled;

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-sirius', 'http://localhost:8012', true, 'unknown')
ON CONFLICT (service_name) DO UPDATE SET
  base_url = EXCLUDED.base_url,
  enabled  = EXCLUDED.enabled;

-- ── Phase F.1: Chemistry builtin tools ───────────────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'propose_retrosynthesis',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "smiles": {
        "type": "string",
        "minLength": 1,
        "maxLength": 10000,
        "description": "Target molecule SMILES."
      },
      "max_depth": {
        "type": "integer",
        "default": 3,
        "minimum": 1,
        "maximum": 6,
        "description": "Maximum retrosynthesis depth."
      },
      "max_branches": {
        "type": "integer",
        "default": 4,
        "minimum": 1,
        "maximum": 10,
        "description": "Maximum branches per step."
      },
      "prefer_aizynth": {
        "type": "boolean",
        "default": false,
        "description": "If true, skip ASKCOS and go directly to AiZynthFinder."
      }
    },
    "required": ["smiles"]
  }',
  'Propose multi-step retrosynthesis routes via ASKCOS v2. Falls back to AiZynthFinder on timeout or 503. Returns ranked routes with step-level scores.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'predict_reaction_yield',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "rxn_smiles_list": {
        "type": "array",
        "items": {"type": "string", "minLength": 1},
        "minItems": 1,
        "maxItems": 100,
        "description": "List of reaction SMILES to predict yield for (max 100)."
      }
    },
    "required": ["rxn_smiles_list"]
  }',
  'Predict expected yield for a list of reaction SMILES using chemprop v2 MPNN. Returns predicted_yield (0-100) and uncertainty std per reaction.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'predict_molecular_property',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "smiles_list": {
        "type": "array",
        "items": {"type": "string", "minLength": 1},
        "minItems": 1,
        "maxItems": 100,
        "description": "List of SMILES to predict a property for (max 100)."
      },
      "property": {
        "type": "string",
        "enum": ["logP", "logS", "mp", "bp"],
        "description": "Molecular property to predict."
      }
    },
    "required": ["smiles_list", "property"]
  }',
  'Predict a molecular property (logP, logS, melting point, or boiling point) for a list of SMILES using chemprop v2 MPNN.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'compute_conformer_ensemble',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "smiles": {
        "type": "string",
        "minLength": 1,
        "maxLength": 10000,
        "description": "SMILES of the molecule."
      },
      "n_conformers": {
        "type": "integer",
        "default": 20,
        "minimum": 1,
        "maximum": 100,
        "description": "Maximum number of conformers to return."
      },
      "method": {
        "type": "string",
        "enum": ["GFN2-xTB", "GFN-FF"],
        "default": "GFN2-xTB",
        "description": "Semi-empirical method. GFN2-xTB for drug-like molecules; GFN-FF for macrocycles."
      },
      "optimize_first": {
        "type": "boolean",
        "default": true,
        "description": "Run geometry optimization before conformer search."
      }
    },
    "required": ["smiles"]
  }',
  'Generate a Boltzmann-weighted conformer ensemble via GFN2-xTB + CREST. Use for stereo, atropisomerism, or ring-flip questions. Latency ~30-60 s.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'identify_unknown_from_ms',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "ms2_peaks": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "m_z": {"type": "number", "exclusiveMinimum": 0},
            "intensity": {"type": "number", "exclusiveMinimum": 0}
          },
          "required": ["m_z", "intensity"]
        },
        "minItems": 1,
        "maxItems": 5000,
        "description": "MS2 peak list as [{m_z, intensity}] pairs."
      },
      "precursor_mz": {
        "type": "number",
        "exclusiveMinimum": 0,
        "maximum": 10000,
        "description": "Precursor m/z (monoisotopic)."
      },
      "ionization": {
        "type": "string",
        "enum": ["positive", "negative"],
        "default": "positive",
        "description": "Electrospray ionization mode."
      }
    },
    "required": ["ms2_peaks", "precursor_mz"]
  }',
  'Identify an unknown compound from MS2 spectra using SIRIUS 6 + CSI:FingerID + CANOPUS. Returns ranked structural candidates with ClassyFire classification. Latency ~60-120 s.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── Source-system MCP services (Phase F.2 reboot) ────────────────────────────
-- Local Postgres-backed mock ELN. Registers under the same source-cache
-- hook regex (/^(query|fetch)_(eln|lims|instrument)_/) as the dropped
-- vendor adapters; downstream KG plumbing is unchanged.

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-eln-local', 'http://localhost:8013', true, 'unknown')
ON CONFLICT (service_name) DO UPDATE SET
  base_url = EXCLUDED.base_url,
  enabled  = EXCLUDED.enabled;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'query_eln_experiments',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "project_code": {"type": "string", "minLength": 1, "maxLength": 64,
                       "description": "Project code (e.g. NCE-1234)."},
      "schema_kind":  {"type": "string", "maxLength": 64,
                       "description": "Optional schema kind filter (e.g. ord-v0.3)."},
      "reaction_id":  {"type": "string", "maxLength": 128,
                       "description": "Optional canonical reaction id filter."},
      "since":        {"type": "string", "format": "date-time",
                       "description": "Optional ISO-8601 lower bound on modified_at."},
      "entry_shape":  {"type": "string", "enum": ["mixed", "pure-structured", "pure-freetext"]},
      "data_quality_tier": {"type": "string", "enum": ["clean", "partial", "noisy", "failed"]},
      "limit":        {"type": "integer", "minimum": 1, "maximum": 200, "default": 50},
      "cursor":       {"type": "string", "maxLength": 256,
                       "description": "Opaque keyset cursor returned by the previous page."}
    },
    "required": ["project_code"]
  }',
  'Query the local mock ELN for experiments. Returns keyset-paginated ElnEntry rows; pass next_cursor back as cursor to continue.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'fetch_eln_entry',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "entry_id": {"type": "string", "minLength": 1, "maxLength": 128,
                   "description": "ELN entry id."}
    },
    "required": ["entry_id"]
  }',
  'Fetch one ELN entry by id with full fields_jsonb, freetext, attachments, and audit summary.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'query_eln_canonical_reactions',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "family":         {"type": "string", "maxLength": 64,
                         "description": "Reaction family (e.g. amide_coupling)."},
      "project_code":   {"type": "string", "maxLength": 64,
                         "description": "Project code filter."},
      "step_number":    {"type": "integer", "minimum": 0, "maximum": 100},
      "min_ofat_count": {"type": "integer", "minimum": 0, "maximum": 10000,
                         "description": "Only return reactions with at least this many OFAT child entries."},
      "limit":          {"type": "integer", "minimum": 1, "maximum": 200, "default": 50}
    }
  }',
  'Query canonical reactions in the local mock ELN with OFAT campaign sizes (one row per canonical reaction, not per OFAT child).',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'fetch_eln_canonical_reaction',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "reaction_id": {"type": "string", "minLength": 1, "maxLength": 128,
                      "description": "Canonical reaction id."},
      "top_n_ofat":  {"type": "integer", "minimum": 0, "maximum": 200, "default": 10,
                      "description": "Number of OFAT child entries to include (sorted by yield desc)."}
    },
    "required": ["reaction_id"]
  }',
  'Fetch one canonical reaction plus its top-N OFAT child entries (sorted by yield descending).',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'fetch_eln_sample',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "sample_id": {"type": "string", "minLength": 1, "maxLength": 128,
                    "description": "Sample id."}
    },
    "required": ["sample_id"]
  }',
  'Fetch one ELN sample (isolated material) with all linked analytical results.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'query_eln_samples_by_entry',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "entry_id": {"type": "string", "minLength": 1, "maxLength": 128,
                   "description": "ELN entry id (UUID)."}
    },
    "required": ["entry_id"]
  }',
  'List every sample linked to one ELN entry. Use after fetch_eln_canonical_reaction or fetch_eln_entry to bridge into analytical data via query_instrument_datasets.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── Phase F.2: LOGS-by-SciY analytical SDMS adapter ─────────────────────────

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-logs-sciy', 'http://localhost:8016', true, 'unknown')
ON CONFLICT (service_name) DO UPDATE SET
  base_url = EXCLUDED.base_url,
  enabled  = EXCLUDED.enabled;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'query_instrument_runs',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "instrument_kind": {"type": "array", "items": {"type": "string",
                            "enum": ["HPLC", "NMR", "MS", "GC-MS", "LC-MS", "IR"]},
                          "minItems": 1, "maxItems": 6,
                          "description": "Instrument family filter."},
      "since":          {"type": "string", "description": "ISO-8601 lower bound on measured_at."},
      "project_code":   {"type": "string", "minLength": 1, "maxLength": 64,
                         "description": "Project code matching mock_eln.projects.code."},
      "sample_name":    {"type": "string", "minLength": 1, "maxLength": 200,
                         "description": "Partial-match filter on sample_name."},
      "limit":          {"type": "integer", "minimum": 1, "maximum": 200, "default": 50},
      "cursor":         {"type": "string", "description": "Opaque keyset cursor from a previous call."}
    }
  }',
  'Search analytical instrument runs (HPLC, NMR, MS, etc.) recorded in LOGS-by-SciY. Filter by instrument_kind, since, project_code, or partial sample_name.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'fetch_instrument_run',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "uid": {"type": "string", "minLength": 1, "maxLength": 128,
              "description": "LOGS dataset UID."}
    },
    "required": ["uid"]
  }',
  'Fetch a single LOGS-by-SciY analytical dataset by UID. Returns parameters and detector tracks.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'query_instrument_datasets',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "sample_id": {"type": "string", "minLength": 1, "maxLength": 128,
                    "description": "Sample identifier matching mock_eln.samples.sample_code."}
    },
    "required": ["sample_id"]
  }',
  'Find all LOGS-by-SciY analytical datasets recorded for a given sample_id.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

COMMIT;
