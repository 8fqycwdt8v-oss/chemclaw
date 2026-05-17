# ChemClaw Tools & Functions Reference

Comprehensive reference for all tools, hooks, skills, and MCP service endpoints available in ChemClaw. ChemClaw is an autonomous knowledge-intelligence agent for pharmaceutical chemical and analytical development.

---

## Quick Navigation

| Document | Contents |
|---|---|
| [builtin-tools-a-l.md](builtin-tools-a-l.md) | 52 agent builtins — `add_forged_tool_test` → `list_synthesis_campaigns` |
| [builtin-tools-m-z.md](builtin-tools-m-z.md) | 55 agent builtins — `manage_plan` → `workflow_pause_resume` |
| [builtin-tools-qm.md](builtin-tools-qm.md) | 6 QM builtins + 3 workflow execution tools (cross-referenced in m-z) |
| [hooks.md](hooks.md) | 29 lifecycle hooks — pre_tool guards, post_tool observers, telemetry |
| [skills.md](skills.md) | 23 domain skills — retrosynthesis, optimization, QM pipelines, research |
| [mcp-services.md](mcp-services.md) | 15+ MCP services — cheminformatics, QM, KG, prediction, analytics |
| [shared-types.md](shared-types.md) | Shared Zod schemas — ELN entities, QM request/response, campaign types, KG confidence tiers |

---

## Architecture Overview

The agent's tool surface has four layers:

```
┌──────────────────────────────────────────────────────────────┐
│  Agent (TypeScript, port 3101)                               │
│  ├── Builtin Tools (~107 tools, TypeScript wrappers)         │
│  ├── Forged Tools (user-defined, stored in DB + skill_library│
│  ├── Skills (domain behavior packs, 23 registered)           │
│  └── Lifecycle Hooks (29 hooks, 16 phases)                   │
└──────────────────────────────────────────────────────────────┘
                          │
              MCP Bearer Token Auth (HS256)
                          │
┌──────────────────────────────────────────────────────────────┐
│  MCP Tool Services (Python, stateless FastAPI microservices)  │
│  ├── mcp-rdkit        (port 8001)    — cheminformatics        │
│  ├── mcp-drfp         (port 8002)    — reaction fingerprints  │
│  ├── mcp-chemprop     (port 8009)    — yield/property ML      │
│  ├── mcp-xtb          (port 8010)    — QM via xTB/CREST       │
│  ├── mcp-askcos       (port 8007)    — retrosynthesis          │
│  ├── mcp-aizynth      (port 8008)    — retrosynthesis          │
│  ├── mcp-kg           (port 8003)    — knowledge graph         │
│  ├── mcp-applicability-domain        — AD assessment           │
│  └── ... (10+ additional services)                            │
└──────────────────────────────────────────────────────────────┘
                          │
┌──────────────────────────────────────────────────────────────┐
│  Data Layer                                                   │
│  ├── Postgres + pgvector (app state, RLS, event log)         │
│  └── Neo4j Community (bi-temporal KG via Graphiti)           │
└──────────────────────────────────────────────────────────────┘
```

---

## Tool Categories at a Glance

### Knowledge Graph & Retrieval
| Tool | Purpose |
|---|---|
| `query_kg` | Query bi-temporal KG facts with confidence scoring |
| `query_kg_at_time` | Query KG at a historical timestamp |
| `promote_to_kg` | Write new facts to the knowledge graph |
| `query_provenance` | Retrieve provenance and origin of a specific fact |
| `check_contradictions` | Detect contradictions between KG facts |
| `retrieve_related` | Retrieve related facts via graph traversal |
| `search_knowledge` | Full-text + semantic search across all indexed content |

### ELN / LIMS Source Systems
| Tool | Purpose |
|---|---|
| `query_eln_experiments` | Query ELN experiments with filtering |
| `fetch_eln_entry` | Fetch full ELN experiment entry by ID |
| `query_eln_canonical_reactions` | Query canonical reactions from ELN |
| `fetch_eln_canonical_reaction` | Fetch a single canonical reaction record |
| `query_eln_samples_by_entry` | Query ELN samples filtered by entry |
| `fetch_eln_sample` | Fetch a specific ELN sample |
| `query_lims_results` | Query LIMS analytical results |
| `fetch_lims_result` | Fetch a LIMS result by ID |
| `query_instrument_runs` | Query HPLC / NMR instrument runs |
| `fetch_instrument_run` | Fetch a single instrument run |
| `query_instrument_datasets` | Query instrument datasets |
| `query_instrument_persons` | Query instrument operators/personnel |

### Chemical Structure & Similarity
| Tool | Purpose |
|---|---|
| `canonicalize_smiles` | Normalize SMILES to canonical form (RDKit) |
| `inchikey_from_smiles` | Generate InChIKey from SMILES |
| `find_similar_compounds` | K-nearest compounds by Tanimoto similarity |
| `find_similar_reactions` | K-nearest reactions by DRFP similarity |
| `find_matched_pairs` | Matched molecular pairs (MMP) for SAR |
| `substructure_search` | Find compounds containing a SMARTS substructure |
| `match_smarts_catalog` | Match SMARTS pattern against compound catalog |
| `classify_compound` | Classify compound into chemical categories |

### Prediction & Screening
| Tool | Purpose |
|---|---|
| `predict_reaction_yield` | Chemprop MPNN yield prediction |
| `predict_yield_with_uq` | Yield prediction with uncertainty quantification |
| `predict_molecular_property` | Predict logP, logS, mp, bp |
| `screen_admet` | ADMET property screening |
| `assess_applicability_domain` | Check if predictions are in-domain |
| `score_green_chemistry` | E-factor, atom economy, PMI metrics |
| `pubchem_ghs_lookup` | GHS hazard classifications from PubChem |

### Quantum Chemistry (xTB / CREST)
| Tool | Purpose |
|---|---|
| `qm_single_point` | Single-point energy, HOMO-LUMO, dipole |
| `qm_geometry_opt` | Geometry optimization with convergence check |
| `qm_frequencies` | Vibrational frequencies + thermochemistry |
| `qm_fukui` | Fukui f⁺/f⁻/f⁰ reactivity indices |
| `qm_redox_potential` | IPEA-xTB reduction potential estimate |
| `qm_crest_screen` | CREST conformer/tautomer/protomer ensemble |
| `compute_conformer_ensemble` | Generate ensemble of low-energy conformers |
| `conformer_aware_kg_query` | KG query with conformer-dependent properties |
| `run_xtb_workflow` | Multi-step xTB workflow recipe |

### Synthesis & Campaign Management
| Tool | Purpose |
|---|---|
| `start_synthesis_campaign` | Create synthesis campaign (single_experiment/library/screening/bo/bo_or_die) |
| `add_synthesis_campaign_step` | Add a step to a running campaign |
| `advance_synthesis_campaign` | Advance campaign to next pending step |
| `update_synthesis_campaign_step` | Modify existing campaign step |
| `record_synthesis_campaign_outcome` | Log experimental results to campaign |
| `get_synthesis_campaign` | Retrieve campaign status and history |
| `list_synthesis_campaigns` | List active and historical campaigns |
| `ingest_campaign_results` | Ingest synthesis campaign results for BO |

### Optimization Campaigns
| Tool | Purpose |
|---|---|
| `start_optimization_campaign` | Initiate reaction condition optimization (BoFire) |
| `recommend_next_batch` | AI recommendation for next synthesis batch |
| `ingest_campaign_results` | Feed measured results back to optimizer |
| `extract_pareto_front` | Extract Pareto-optimal compounds |
| `start_chrom_campaign` | Initiate HPLC method optimization campaign |
| `recommend_next_chrom_batch` | Recommend next chromatography conditions |
| `ingest_chrom_results` | Ingest chromatography results |
| `extract_chrom_pareto_front` | Extract Pareto chromatography conditions |
| `materialize_chrom_method` | Finalize optimized HPLC method |

### Retrosynthesis & Design
| Tool | Purpose |
|---|---|
| `propose_retrosynthesis` | Multi-step retrosynthesis (ASKCOS / AiZynth) |
| `recommend_conditions` | Recommend reaction conditions (catalyst, solvent, T) |
| `elucidate_mechanism` | Explain reaction mechanism (LLM + KG) |
| `generate_focused_library` | Generate focused compound library |
| `design_plate` | Design HTE (high-throughput experimentation) plate |
| `run_chemspace_screen` | Screen against ChemSpace catalog |
| `expand_reaction_context` | Expand reaction with full context |
| `identify_unknown_from_ms` | Structure identification from MS/MS (SIRIUS) |
| `simulate_chrom_retention` | Predict chromatography retention time |

### Hypotheses & Analysis
| Tool | Purpose |
|---|---|
| `propose_hypothesis` | Generate mechanistic hypothesis (requires cited fact_ids) |
| `update_hypothesis_status` | Track hypothesis validation status |
| `statistical_analyze` | Statistical analysis on experimental data |
| `analyze_csv` | Analyze uploaded CSV data |
| `synthesize_insights` | Compose cross-source insights |
| `compute_confidence_ensemble` | Ensemble-based prediction confidence |

### Knowledge Wiki
| Tool | Purpose |
|---|---|
| `search_knowledge` | Semantic + full-text search |
| `list_articles` | List indexed articles |
| `read_article` | Read full article/document text |
| `request_article` | Request article ingestion/indexing |
| `upsert_article` | Upload/update agent-authored wiki article |
| `fetch_full_document` | Fetch complete document with all chunks |
| `fetch_original_document` | Fetch original source document |
| `query_source_cache` | Query cached source documents |

### Workflow Engine
| Tool | Purpose |
|---|---|
| `workflow_define` | Define new workflow template |
| `workflow_run` | Execute workflow by ID |
| `workflow_inspect` | Inspect workflow execution status |
| `workflow_modify` | Modify workflow parameters |
| `workflow_pause_resume` | Pause or resume a running workflow |
| `workflow_replay` | Replay a completed workflow run |
| `promote_workflow_to_tool` | Promote validated workflow to reusable tool |
| `kick_workflow_and_wait` | Trigger and await workflow completion |
| `enqueue_batch` | Queue batch of compounds for processing |
| `inspect_batch` | Inspect batch status and results |

### File System & Execution (E2B Sandbox)
| Tool | Purpose |
|---|---|
| `read_file` | Read file from sandbox filesystem |
| `write_file` | Write file to sandbox filesystem |
| `list_directory` | List directory contents in sandbox |
| `run_program` | Execute external program with arguments |
| `run_shell` | Execute shell command in sandbox |
| `run_orchestration_script` | Run orchestration script (Python/shell) |

### Agent Planning & State
| Tool | Purpose |
|---|---|
| `manage_plan` | Create and manage multi-step research plans |
| `manage_todos` | Create and track todo items (live SSE updates) |
| `mark_research_done` | Mark research task as complete |
| `ask_user` | Pause harness and request user input |
| `request_investigation` | Request detailed human investigation |
| `draft_section` | Draft narrative section (methods, results) |
| `dispatch_sub_agent` | Delegate task to a sub-agent |

### Tool Forging & Introspection
| Tool | Purpose |
|---|---|
| `forge_tool` | Create custom tool from definition |
| `induce_forged_tool_from_trace` | Auto-induce tool from execution trace |
| `add_forged_tool_test` | Add test case to forged tool |

### Reporting & Export
| Tool | Purpose |
|---|---|
| `export_to_ord` | Export reaction to Open Reaction Database format |

---

## Lifecycle Hook Phases

| Phase | When | Key Hooks |
|---|---|---|
| `session_start` | Session creation | `session-events` |
| `pre_turn` | Before LLM call | `init-scratch`, `apply-skills` |
| `pre_tool` | Before any tool runs | `budget-guard`, `loop-detector`, `scheduled-substance-gate`, `foundation-citation-guard`, `wiki-human-block-guard`, `permission` |
| `post_tool` | After tool returns | `anti-fabrication`, `tag-maturity`, `source-cache`, `detect-mcp-leakage`, `fact-id-consistency-guard`, `compute-result-writer`, `tool-invocation-emitter`, `redact-tool-output` (order 200, runs last) |
| `post_tool_failure` | After tool throws | `post-tool-failure-telemetry`, `tool-invocation-emitter` |
| `post_tool_batch` | After parallel readonly batch | `post-tool-batch-telemetry` |
| `permission_request` | Every tool call | `permission` |
| `subagent_start/stop` | Around sub-agent runs | Telemetry stubs |
| `task_created/completed` | `manage_todos` mutations | Telemetry stubs |
| `pre_compact` | Context > 60% of budget | `compact-window` |
| `post_compact` | After compaction | `post-compact-telemetry` |
| `post_turn` | After each turn (in finally) | `redact-secrets`, `kg-conclusion-extractor` |
| `session_end` | Session finalization | `session-end-telemetry`, `session-sandbox-close` |

---

## Environment Variables Reference

| Variable | Service | Description |
|---|---|---|
| `MCP_AUTH_SIGNING_KEY` | agent-claw | HS256 key for MCP JWT minting (≥ 32 chars) |
| `MCP_AUTH_DEV_MODE` | all MCP | Set `true` to bypass token validation in dev |
| `MCP_AUTH_REQUIRED` | all MCP | Overrides dev mode when both set |
| `AGENT_TOKEN_BUDGET` | agent-claw | Max tokens per session (default varies) |
| `AGENT_LOG_LEVEL` | agent-claw | Pino log level (`info`, `debug`, `warn`) |
| `LOG_USER_SALT` | agent-claw | MUST be set; hashes user IDs in logs |
| `AGENT_ADMIN_USERS` | agent-claw | Bootstrap global admin fallback |
| `AGENT_PLAN_MAX_AUTO_TURNS` | agent-claw | Max auto-turns for chained plan execution |
| `POSTGRES_DSN` | Python services | Connection string for Python MCP tools |
| `CHEMPROP_MODEL_DIR` | mcp-chemprop | Path to pretrained chemprop model files |
| `ASKCOS_MODEL_DIR` | mcp-askcos | Path to ASKCOS model checkpoint directory |
| `AIZYNTH_CONFIG` | mcp-aizynth | Path to AiZynthFinder config YAML |

---

## Row-Level Security Notes

All agent queries run as the `chemclaw_app` DB role with `FORCE ROW LEVEL SECURITY`. Every query requires a valid `app.current_user_entra_id` setting. The TypeScript agent uses `withUserContext(pool, userEntraId, fn)` from `services/agent-claw/src/db/with-user-context.ts`. Projectors and system workers connect as `chemclaw_service` (BYPASSRLS).

---

*Generated 2026-05-17. Run `make test-counts` to get current test counts. Architecture: `docs/adr/001-architecture.md`.*
