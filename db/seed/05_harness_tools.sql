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

-- ── Z3-Z5 reaction-condition optimization MCPs ──────────────────────────────

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-yield-baseline', 'http://localhost:8015', true, 'unknown')
ON CONFLICT (service_name) DO UPDATE SET
  base_url = EXCLUDED.base_url,
  enabled  = EXCLUDED.enabled;

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-reaction-optimizer', 'http://localhost:8018', true, 'unknown')
ON CONFLICT (service_name) DO UPDATE SET
  base_url = EXCLUDED.base_url,
  enabled  = EXCLUDED.enabled;

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-plate-designer', 'http://localhost:8020', true, 'unknown')
ON CONFLICT (service_name) DO UPDATE SET
  base_url = EXCLUDED.base_url,
  enabled  = EXCLUDED.enabled;

INSERT INTO mcp_tools (service_name, base_url, enabled, health_status)
VALUES ('mcp-ord-io', 'http://localhost:8021', true, 'unknown')
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

-- ── Autonomy primitives (multi-turn session features) ───────────────────────
-- These two builtins drive the Claude-Code-like long-running flow:
-- * `manage_todos` lets the LLM sketch a checklist + tick items as work
--   proceeds; each write fires a todo_update SSE event for the UI.
-- * `ask_user` pauses the harness with a clarifying question when something
--   genuinely blocks progress — the next user message resumes the session.
-- Previously absent from the seed catalog (only registered programmatically
-- in services/agent-claw/src/index.ts), which meant `loadFromDb` couldn't
-- materialize them at runtime — the harness ran without these tools
-- advertised to the LLM whenever the catalog was the registry source.

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'manage_todos',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "op": {"type": "string", "enum": ["list", "add", "update", "remove"]},
      "items": {"type": "array", "items": {"type": "string"}},
      "id": {"type": "string"},
      "content": {"type": "string"},
      "status": {"type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"]}
    },
    "required": ["op"]
  }',
  'Read or write the session-scoped todo list. Use `op:"add"` with an `items` array at the START of any 3+ step task to sketch a plan; use `op:"update"` with `{id, status}` to tick items off as you finish them. Each write emits a todo_update SSE event so the user sees live progress. The list survives across turns within one session_id.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'ask_user',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "question": {"type": "string", "minLength": 1, "maxLength": 500}
    },
    "required": ["question"]
  }',
  'Pause and surface a single clarifying question to the user. The harness terminates the turn with finish_reason="awaiting_user_input"; the next /api/chat post on the same session_id resumes the loop with the user''s answer. Call ONLY when the question genuinely blocks progress — speculation or polish is not a reason. Cost: 1 round-trip to the user.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── LOGS Person directory (lookup operators behind a fetched run) ──────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'query_instrument_persons',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "name_contains": {"type": "string", "minLength": 1, "maxLength": 200,
                        "description": "Case-insensitive partial match on display_name."},
      "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50}
    }
  }',
  'List operators / analysts known to the analytical SDMS (LOGS) Person directory. Use to resolve the `operator` username on a fetched instrument run into display_name + email for citation attribution.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── Reaction condition prediction (Phase Z0) ──────────────────────────────
-- recommend_conditions: top-k condition sets for a target reaction. Backed
-- by mcp-askcos /recommend_conditions (ASKCOS condition recommender).

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'recommend_conditions',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "reactants_smiles": {
        "type": "string",
        "minLength": 1,
        "maxLength": 10000,
        "description": "Dot-separated SMILES of the reactants."
      },
      "product_smiles": {
        "type": "string",
        "minLength": 1,
        "maxLength": 10000,
        "description": "SMILES of the desired product."
      },
      "top_k": {
        "type": "integer",
        "minimum": 1,
        "maximum": 20,
        "default": 5,
        "description": "Number of condition sets to return (1-20, default 5)."
      }
    },
    "required": ["reactants_smiles", "product_smiles"]
  }',
  'Propose top-k reaction condition sets {catalysts, reagents, solvents, temperature_c, score} for a target transformation given reactants + product SMILES. Backed by the ASKCOS condition recommender (USPTO-trained, top-10 includes ground truth ~70%, T MAE ~20°C). Output should be applicability-domain-checked before reporting.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── Yield baseline ensemble (Phase Z3) ────────────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'predict_yield_with_uq',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "rxn_smiles_list": {
        "type": "array",
        "items": {"type": "string", "minLength": 1, "maxLength": 20000},
        "minItems": 1,
        "maxItems": 100,
        "description": "Reaction SMILES to predict yield for."
      },
      "project_internal_id": {
        "type": "string",
        "maxLength": 200,
        "description": "Optional NCE project internal_id; per-project model is used when available."
      }
    },
    "required": ["rxn_smiles_list"]
  }',
  'Predict yield with calibrated uncertainty. Combines chemprop''s MVE-head std (aleatoric) with chemprop-XGBoost disagreement (epistemic) into a single ensemble_std. Returns per-reaction ensemble_mean + ensemble_std + component scores. Per-project XGBoost trained on user''s RLS-scoped reactions; global pretrained fallback when project has < 50 labeled reactions.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── HTE plate design + ORD I/O (Phase Z4) ─────────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'design_plate',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "plate_format": {"type": "string", "enum": ["24","96","384","1536"]},
      "reactants_smiles": {"type": "string", "maxLength": 20000},
      "product_smiles": {"type": "string", "maxLength": 10000},
      "factors": {"type": "array", "items": {"type": "object"}, "maxItems": 10},
      "categorical_inputs": {"type": "array", "items": {"type": "object"}, "maxItems": 10},
      "exclusions": {"type": "object"},
      "n_wells": {"type": "integer", "minimum": 1, "maximum": 1536},
      "seed": {"type": "integer", "default": 42},
      "annotate_yield": {"type": "boolean", "default": false},
      "project_internal_id": {"type": "string", "maxLength": 200},
      "disable_chem21_floor": {"type": "boolean", "default": false}
    },
    "required": ["plate_format", "n_wells"]
  }',
  'Design an HTE plate (24/96/384/1536) via BoFire space-filling DoE. Excluded solvents are dropped from the categorical input; the CHEM21 safety floor auto-drops HighlyHazardous solvents. Optionally annotates each well with predict_yield_with_uq.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'export_to_ord',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "plate_name": {"type": "string", "minLength": 1, "maxLength": 200},
      "reactants_smiles": {"type": "string", "maxLength": 20000},
      "product_smiles": {"type": "string", "maxLength": 10000},
      "wells": {"type": "array", "items": {"type": "object"}, "minItems": 1, "maxItems": 2000}
    },
    "required": ["wells"]
  }',
  'Export a plate (or any list of well dicts with factor values) into an Open Reaction Database (ORD) Dataset protobuf, base64-encoded. Portable format for downstream HTE robotics or LIMS systems.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── Closed-loop optimization (Phase Z5) ───────────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'start_optimization_campaign',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "campaign_name": {"type": "string", "minLength": 1, "maxLength": 200},
      "nce_project_internal_id": {"type": "string", "minLength": 1, "maxLength": 200},
      "factors": {"type": "array", "items": {"type": "object"}, "maxItems": 20},
      "categorical_inputs": {"type": "array", "items": {"type": "object"}, "maxItems": 20},
      "outputs": {"type": "array", "items": {"type": "object"}, "minItems": 1, "maxItems": 10},
      "campaign_type": {"type": "string", "enum": ["single_objective","multi_objective"], "default": "single_objective"},
      "strategy": {"type": "string", "enum": ["SoboStrategy","MoboStrategy","RandomStrategy","QnehviStrategy"], "default": "SoboStrategy"},
      "acquisition": {"type": "string", "enum": ["qLogEI","qLogNEI","qNEHVI","qEHVI","random"], "default": "qLogEI"}
    },
    "required": ["campaign_name", "nce_project_internal_id", "outputs"]
  }',
  'Create a closed-loop optimization campaign. Validates the factor space via BoFire, persists Domain JSON, returns the campaign_id for subsequent recommend_next_batch calls.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'recommend_next_batch',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "campaign_id": {"type": "string"},
      "n_candidates": {"type": "integer", "minimum": 1, "maximum": 200, "default": 8},
      "seed": {"type": "integer", "default": 42}
    },
    "required": ["campaign_id"]
  }',
  'Propose the next batch for an open optimization campaign. Pulls measured outcomes from prior rounds (RLS-scoped), fits a BoFire Strategy, returns n_candidates next conditions. Cold-start (< 3 observations) returns space-filling random.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'ingest_campaign_results',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "round_id": {"type": "string"},
      "measured_outcomes": {"type": "array", "items": {"type": "object"}, "minItems": 1, "maxItems": 2000}
    },
    "required": ["round_id", "measured_outcomes"]
  }',
  'Record measured outcomes for a previously-proposed optimization round. After ingestion, the next recommend_next_batch call incorporates these observations into the BoFire Strategy.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── Multi-objective Pareto extraction (Phase Z6) ──────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'extract_pareto_front',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "campaign_id": {"type": "string"}
    },
    "required": ["campaign_id"]
  }',
  'Compute the Pareto frontier (non-dominated set) of a campaign''s measured outcomes. Each output is treated per its declared direction. Surfaces the trade-off frontier in multi-objective campaigns (yield x selectivity x PMI x greenness x safety).',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── Applicability-domain & green-chemistry (Phase Z1) ─────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'score_green_chemistry',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "solvents": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "smiles": {"type": "string", "minLength": 1, "maxLength": 10000},
            "name":   {"type": "string", "minLength": 1, "maxLength": 200}
          }
        },
        "minItems": 1,
        "maxItems": 50,
        "description": "Solvents to score; each entry needs a smiles or a name."
      }
    },
    "required": ["solvents"]
  }',
  'Score solvents against CHEM21 / GSK / Pfizer / AZ / Sanofi / ACS GCI-PR guides. Returns per-solvent class + score + match_confidence (smiles_exact / inchikey / name_only / unmatched). Use BEFORE proposing conditions so the soft-greenness penalty in condition-design can be applied.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'assess_applicability_domain',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "rxn_smiles": {
        "type": "string",
        "minLength": 3,
        "maxLength": 20000,
        "description": "Reaction SMILES (reactants>>products)."
      },
      "project_internal_id": {
        "type": "string",
        "maxLength": 200,
        "description": "Optional NCE project internal_id; calibration is per-project."
      }
    },
    "required": ["rxn_smiles"]
  }',
  'Three-signal applicability-domain verdict for a reaction: Tanimoto-NN, Mahalanobis, conformal-prediction interval width. Returns verdict (in_domain/borderline/out_of_domain) + underlying scores. Annotate-don''t-block: the verdict is descriptive; the chemist still sees every recommendation.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

-- ── Code-mode orchestration via Monty (Phase G) ───────────────────────────
-- run_orchestration_script lets the agent emit one Python script that calls
-- allow-listed tools as external_function(...). Each inner call still flows
-- through the standard permission + pre_tool + post_tool pipeline. Disabled
-- at runtime by default; admins enable via config_settings (monty.enabled
-- + monty.binary_path).

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'run_orchestration_script',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "python_code": {
        "type": "string",
        "minLength": 1,
        "maxLength": 50000,
        "description": "Python source. May call external_function(\"<tool_id>\", {...}) for any id in allowed_tools. Stdlib subset only (no third-party packages, no classes)."
      },
      "allowed_tools": {
        "type": "array",
        "items": {"type": "string", "minLength": 1, "maxLength": 128},
        "minItems": 1,
        "maxItems": 32,
        "description": "Tool ids the script may call. Each is re-validated against the permission resolver before the script starts."
      },
      "inputs": {
        "type": "object",
        "additionalProperties": true,
        "description": "Named inputs injected as Python globals before the script runs."
      },
      "expected_outputs": {
        "type": "array",
        "items": {"type": "string", "minLength": 1, "maxLength": 128},
        "minItems": 1,
        "maxItems": 50,
        "description": "Variable names the script is expected to set; harvested as the outputs map."
      },
      "reason": {
        "type": "string",
        "minLength": 1,
        "maxLength": 1000,
        "description": "Audit reason - why code-mode beats sequential ReAct for this task."
      },
      "timeout_ms": {
        "type": "integer",
        "minimum": 1000,
        "maximum": 600000,
        "description": "Per-script wall-time cap. Defaults to monty.wall_time_ms."
      }
    },
    "required": ["python_code", "allowed_tools", "expected_outputs", "reason"]
  }',
  'Execute a short Python script in the Monty sandbox. Use this when you would otherwise emit 3+ sequential read-only tool calls that compose data through pure-Python operations (filter, sort, dedupe, join, top-k). Each external_function call goes through the standard permission + pre_tool + post_tool pipeline. Do not use for tools that prompt the user (ask_user), write to the DB (enqueue_batch, workflow_*), or run generative chemistry.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

COMMIT;
