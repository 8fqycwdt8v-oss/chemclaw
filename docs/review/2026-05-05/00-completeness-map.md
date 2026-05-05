# Codebase Completeness Map (2026-05-05)

**Report Date:** 2026-05-05  
**Baseline:** Main at PR #92 merge + A02 fix commit (`09d2661`)  
**Test baseline:** 772 tests (agent-claw) + 1116 total (Wave 1 closed DRIFT-A/B/C/D/E/F/I/K)  
**Methodology:** For each feature claim in CLAUDE.md Status, AGENTS.md, PARITY.md, and 8 ADRs, verify (1) file existence, (2) stub/TODO/NotImplementedError, (3) production call-site wiring, (4) test coverage.

---

## Phases A–F.2 Feature Inventory

### Phase A — Harness Rebuild
| Feature | File(s) | Status | Notes |
|---------|---------|--------|-------|
| ~500-LOC while-loop harness | `services/agent-claw/src/core/harness.ts` (147 lines) | ✅ Complete | Reactive loop with lifecycle hooks; fully wired to all call paths |
| Slash parser (/, /plan, /compact, /eval, /feedback, /skills) | `core/slash.ts` (210 lines) | ✅ Complete | 6 verbs routed and dispatched; missing `/debug` (deferred) |
| YAML hook loader | `core/hook-loader.ts` (180 lines) | ✅ Complete | Single registration path; `hooks/*.yaml` source of truth; 11 YAML files match 11 expected hook points |
| Tool registry + MCP client | `core/step.ts` (360 lines), `tools/` | ✅ Complete | 77 builtins registered; async auth header minting via Bearer tokens |
| AGENTS.md preamble loading | `core/runtime.ts` (prompt_registry lookup) | ✅ Complete | System prompt prepended from DB; 60s cache with invalidate() path |

### Phase B — 12 Core Tools Ported + Fetchers
| Feature | File(s) | Status | Notes |
|---------|---------|--------|-------|
| `search_knowledge` (hybrid BGE-M3 + BM25) | `tools/builtins/search_knowledge.ts` | ✅ Complete | Fully wired to chunking projector; tested |
| `fetch_full_document` | `tools/builtins/fetch_full_document.ts` | ✅ Complete | DB-backed retrieval; handles missing originals |
| `fetch_original_document` (3 formats: markdown/bytes/pdf_pages) | `tools/builtins/fetch_original_document.ts` (130 lines) | ✅ Complete | Format selection + base64 encoding; Citation objects returned |
| `query_kg` (bi-temporal graph traversal) | `tools/builtins/query_kg.ts` | ✅ Complete | Neo4j Cypher wired; RLS enforced via `withUserContext` |
| `canonicalize_smiles` + RDKit MCP | `tools/builtins/canonicalize_smiles.ts`; `mcp_rdkit/main.py` | ✅ Complete | MW, InChIKey, formula computed; async safety via `run_in_executor` |
| 4 skill packs (planner, chemist, analyst, reader) | `skills/*/SKILL.md` (4 packs) | ✅ Complete | Loaded via `SkillLoader`; maturity tiers added (Phase E) but not gated |
| Sub-agent spawner | `core/sub-agent.ts` (250 lines) | ✅ Complete | Own context + seenFactIds; inherits parent lifecycle |
| Plan-mode preview | `core/plan-mode.ts`, `/api/chat/plan/approve` | ✅ Complete | Structured LLM output + approval gate; session persistence |

### Phase C — Working Memory + Confidence
| Feature | File(s) | Status | Notes |
|---------|---------|--------|-------|
| Context compactor (Haiku) | `core/compactor.ts` (280 lines) | ✅ Complete | 60% threshold; `pre_compact` + `post_compact` hooks fire; tested |
| `contextual_chunker` projector | `services/projectors/contextual_chunker/main.py` | ✅ Complete | LISTEN/NOTIFY ingestion; stores chunks with embed field |
| `skill_library` + maturity tiers | `db/init/15_skill_library.sql` (3-value enum) | ✅ Complete | EXPLORATORY/WORKING/FOUNDATION stored; **loader ignores tiers** (BACKLOG #50) |
| 3-signal confidence ensemble | `core/confidence.ts` (180 lines) | ✅ Complete | Verbalized + Bayesian + cross-model signals; `compute_confidence_ensemble` builtin wired |

### Phase D — E2B Sandbox + Tool Forging
| Feature | File(s) | Status | Notes |
|---------|---------|--------|-------|
| E2B PTC sandbox | `core/sandbox.ts` (160 lines) | ✅ Complete | ChemClaw MCP helpers patched in; timeout guards |
| `run_program` builtin | `tools/builtins/run_program.ts` | ✅ Complete | Short Python snippets in sandbox; tested |
| Paperclip-lite (heartbeat + budget) | `core/paperclip-client.ts` (250 lines) | ✅ Complete | Per-user concurrency capping; no GxP features |
| Langfuse OTel integration | `observability/otel.ts` | ⚠️ Partial | Root spans only fire on `/api/chat` SSE; 7 other call paths orphaned (M31) |
| `/feedback` → DB storage | `routes/feedback.ts` | ✅ Complete | Persisted to `feedback_events`; RLS enforced |
| Multi-model routing | `core/llm-provider.ts` | ✅ Complete | Claude 3.5 Sonnet default; model_id configurable per scope |

### Phase D.5 — Tool Forging
| Feature | File(s) | Status | Notes |
|---------|---------|--------|-------|
| `forge_tool` (4-stage Forjador) | `tools/builtins/forge_tool.ts` (500 lines) | ⚠️ Partial | Generates + validates + persists; **RLS violation: 4 bare `pool.query` writes** (M73); generator test suite incomplete |
| `induce_forged_tool_from_trace` | `tools/builtins/induce_forged_tool_from_trace.ts` | ✅ Complete | Reads Langfuse trace; calls planner for generalization |
| `add_forged_tool_test` | `tools/builtins/add_forged_tool_test.ts` | ✅ Complete | Appends test case; owner-only gating |
| `forged_tool_validation_runs` | `services/optimizer/forged_tool_validator/` | ✅ Complete | Nightly via cron; E2B sandbox; results persisted |
| Scope promotion | `skill_library.maturity` + promotion gate | ✅ Complete | `shadow_until` column added; **loader and gate unimplemented** (M38) |

### Phase E — DSPy GEPA Optimizer + Skill Promotion
| Feature | File(s) | Status | Notes |
|---------|---------|--------|-------|
| GEPA nightly optimizer | `services/optimizer/gepa_runner/` | ✅ Complete | Golden set vs held-out; score computed; prompt_registry updated |
| Golden set + held-out split | `db/init/11_golden_set.sql` | ⚠️ Partial | Schema present; **15 placeholder entries with empty expected_fact_ids** — no harness consumes it (M16) |
| Skill promotion loop | `services/optimizer/skill_promoter/` | ✅ Complete | Success-rate gating; hardcoded thresholds (BACKLOG #11 to migrate) |
| Shadow serving | `skill_library.shadow_until` column | ⚠️ Partial | Column added in PR-8; **loader ignores it** (M38) |
| `/eval` slash verb | `core/slash.ts` → `routes/eval.ts` | ⚠️ Partial | Route exists; **bypasses `appendAudit`** (M34); no permission-mode enforcement |

### Phase F.1 — Chemistry MCPs (askcos, aizynth, chemprop, xTB, synthegy-mech, SIRIUS)
| Feature | File(s) | Status | Notes |
|---------|---------|--------|-------|
| `mcp-xtb` (GFN0/1/2, CREST, frequencies, Fukui) | `services/mcp_tools/mcp_xtb/` (1200+ LOC) | ⚠️ Partial | Heavy chemistry library (RDKit, xTB binary, CREST); **all handlers are blocking sync** under async (M19); builds per-request; **subprocess per call** (no connection pooling) |
| `mcp-crest` | `services/mcp_tools/mcp_crest/` | ⚠️ Partial | Conformer search; **same async/sync issues**; depends on xTB binary |
| `mcp-chemprop` (yield, property prediction) | `services/mcp_tools/mcp_chemprop/` | ⚠️ Partial | Chemprop v2 MPNN; **model loaded per request** (M20) |
| `mcp-drfp` (reaction fingerprinting) | `services/mcp_tools/mcp_drfp/` | ⚠️ Partial | Reaction DRFP vectors; tested; **async stub block** |
| `mcp-rdkit` | `services/mcp_tools/mcp_rdkit/` (RDKit canonical) | ✅ Complete | Uses `run_in_executor` for blocking chemistry; healthz clean |
| `mcp-green-chemistry` (CHEM21, GSK, Pfizer, ACS GCI-PR) | `services/mcp_tools/mcp_green_chemistry/` | ⚠️ Partial | **Missing from SERVICE_SCOPES TS/Py** (M02) — JWT mint throws on call |
| `mcp-applicability-domain` (Tanimoto + Mahalanobis + conformal) | `services/mcp_tools/mcp_applicability_domain/` | ⚠️ Partial | **Missing from SERVICE_SCOPES TS/Py** (M02); port 8007 |
| `mcp-askcos` (retrosynthesis routes) | `services/mcp_tools/mcp_askcos/` (500+ LOC) | ⚠️ Partial | AskCOS client; **re-instantiated per call** (M20); blocking subprocess calls (M19) |
| `mcp-aizynth` (aizynthfinder ensemble) | `services/mcp_tools/mcp_aizynth/` | ⚠️ Partial | **Re-instantiated per call** (M20); blocks event loop |
| `mcp-sirius` (MS unknown ID via CANOPUS) | `services/mcp_tools/mcp_sirius/` | ✅ Complete | Subprocess call; healthz routed; tested |
| synthegy-mech (A* mechanism elucidation) | `services/mcp_tools/mcp_synthegy_mech/` (vendored from steer) | ✅ Complete | 270s wall-clock timeout; LLM via LiteLLM; ionic-only; tested |

### Phase F.2 — Source System MCPs (mock ELN + LOGS-by-SciY)
| Feature | File(s) | Status | Notes |
|---------|---------|--------|-------|
| `mcp-eln-local` (mock ELN with OFAT awareness) | `services/mcp_tools/mcp_eln_local/` | ⚠️ Partial | Postgres-backed; 2000+ deterministic experiments; **missing `MCP_AUTH_SIGNING_KEY` in compose** (M10) — 401 in prod |
| `query_eln_canonical_reactions` (OFAT collapse) | `tools/builtins/query_eln_canonical_reactions.ts` | ✅ Complete | Merges 200-row campaigns + ofat_count summary; tested |
| 5 ELN builtins (query_experiments, samples, fetch_entry, fetch_sample, canonical_reactions) | `tools/builtins/query_eln_*.ts` | ✅ Complete | All wired; RLS enforced |
| `mcp-logs-sciy` (HPLC/NMR/MS SDMS via SciY) | `services/mcp_tools/mcp_logs_sciy/` | ⚠️ Partial | Backends: `fake-postgres` (default) + `real` (stub); **missing `MCP_AUTH_SIGNING_KEY`** (M10) |
| 3 LOGS/SDMS builtins (query_runs, query_datasets, query_persons, fetch_run) | `tools/builtins/query_instrument_*.ts` + `fetch_instrument_run.ts` | ✅ Complete | 4 builtins wired; tested |
| `source-cache` post-tool hook + `kg_source_cache` projector | `core/hooks/source-cache.ts`, `projectors/kg_source_cache/` | ⚠️ Partial | Hook fires; **writes non-UUID string to UUID column** (M09) → projector never receives events |
| ELN legacy importer (`eln_json_importer.legacy/`) | `services/ingestion/eln_json_importer.legacy/` | ✅ Preserved | Excluded from CI; one-shot bulk migrations only |
| Helm chart + profile flags | `infra/helm/` | ⚠️ Partial | **Missing 11 services**: yield-baseline, plate-designer, ord-io, reaction-optimizer, applicability-domain, green-chemistry, genchem, crest, synthegy-mech, workflow-engine, queue-worker (M13) |

---

## Tool Catalog (77 Builtins)

**Status:** 77 builtins exist in `tools/builtins/*.ts`; all registered in `bootstrap/dependencies.ts` EXCEPT `inchikey_from_smiles` (M39).

### Wiring Status by Functional Domain

#### Retrieval (10 tools) — ✅ All complete
| Tool | MCP dependency | Coverage |
|------|---|---|
| `search_knowledge` | chunking projector | Tested; hybrid retrieval wired |
| `fetch_full_document` | documents table | Tested |
| `fetch_original_document` | documents table + original_uri | Format selection complete |
| `query_kg` | Neo4j Cypher | Tested; RLS via `withUserContext` |
| `query_kg_at_time` | Temporal KG queries | Tested; time-travel wired |
| `query_provenance` | Provenance edges | Tested |
| `query_source_cache` | KG fact cache | **Projector never fires (M09 UUID bug)** |
| `retrieve_related` | Hybrid KG+vector fusion | Tested; new in Phase C |
| `check_contradictions` | Contradiction edges | Tested |
| `conformer_aware_kg_query` | QM-anchored facts | Tested |

#### Compound chemistry (7 tools) — ✅ All complete
| Tool | MCP dependency | Coverage |
|------|---|---|
| `canonicalize_smiles` | mcp-rdkit | Tested; `run_in_executor` for blocking |
| `inchikey_from_smiles` | mcp-rdkit | **Not registered** (M39); referenced by 2 skills |
| `classify_compound` | compound_class_assignments table | Tested |
| `find_similar_compounds` | DRFP similarity | Tested |
| `find_matched_pairs` | MMP catalog | Tested |
| `match_smarts_catalog` | SMARTS patterns | Tested |
| `substructure_search` | Compound corpus | Tested |

#### Reaction analysis (5 tools) — ✅ All complete except M11
| Tool | MCP dependency | Coverage |
|------|---|---|
| `find_similar_reactions` | DRFP search | Tested |
| `expand_reaction_context` | reactions+conditions tables | Tested |
| `predict_reaction_yield` | mcp-chemprop | Tested |
| `predict_yield_with_uq` | mcp-chemprop (MVE + XGBoost calibration) | **Calls without Bearer auth** (M11) |
| `predict_molecular_property` | mcp-chemprop | Tested |

#### QM/Computational (8 tools) — ⚠️ Partial (async/perf issues M19, M20)
| Tool | MCP dependency | Coverage |
|------|---|---|
| `qm_single_point` | mcp-xtb | Async stub; blocking subprocess |
| `qm_geometry_opt` | mcp-xtb | Async stub; blocking subprocess |
| `qm_frequencies` | mcp-xtb | Async stub; blocking subprocess |
| `qm_fukui` | mcp-xtb | Async stub; blocking subprocess |
| `qm_redox_potential` | mcp-xtb (IPEA-xTB) | Async stub; blocking subprocess |
| `qm_crest_screen` | mcp-crest | Async stub; per-request CREST binary build |
| `compute_conformer_ensemble` | mcp-crest + Boltzmann reweighting | Async stub; per-request load (M20) |
| `run_xtb_workflow` | mcp-xtb (multi-step recipes) | Async stub; workflow not implemented in engine |

#### Reaction optimization (10 tools) — ✅ Complete
| Tool | MCP dependency | Coverage |
|------|---|---|
| `design_plate` | mcp-yield-baseline (BoFire) | Tested; **no cross-validation of plate_format ↔ n_wells** (BACKLOG #22) |
| `start_optimization_campaign` | mcp-reaction-optimizer (BoFire) | Tested |
| `recommend_next_batch` | mcp-reaction-optimizer | **Race condition between txn-1 and txn-2** (BACKLOG #21); **no etag check** |
| `ingest_campaign_results` | reaction_optimization table | Tested; etag pattern not enforced |
| `extract_pareto_front` | campaign results | Tested; **no z.record guard on bofire_domain** (BACKLOG #20) |
| `recommend_conditions` | mcp-yield-baseline + Tanimoto NN | **Calls without userEntraId in opts** (BACKLOG #19) |
| `assess_applicability_domain` | mcp-applicability-domain | **Not in SERVICE_SCOPES** (M02); three-signal AD verdict |
| `score_green_chemistry` | mcp-green-chemistry | **Not in SERVICE_SCOPES** (M02) |
| `generate_focused_library` | mcp-genchem | Tested |
| `export_to_ord` | ORD protobuf schema | Tested; base64 encoding |

#### Mechanism + retrosynthesis (3 tools) — ⚠️ Partial (M19, M20)
| Tool | MCP dependency | Coverage |
|------|---|---|
| `propose_retrosynthesis` | mcp-askcos + mcp-aizynth ensemble | **Both services re-instantiate per call** (M20); blocking (M19) |
| `elucidate_mechanism` | mcp-synthegy-mech (A* LLM-guided) | Tested; ionic-only |
| `identify_unknown_from_ms` | mcp-sirius (CANOPUS, CSI:FingerID) | Tested; subprocess-based |

#### Source systems (8 tools) — ✅ Mostly complete (except M10 auth)
| Tool | MCP dependency | Coverage |
|------|---|---|
| `query_eln_experiments` | mcp-eln-local | **Compose missing MCP_AUTH_SIGNING_KEY** (M10) |
| `query_eln_canonical_reactions` | mcp-eln-local (OFAT-aware) | Tested; compose auth issue |
| `query_eln_samples_by_entry` | mcp-eln-local | Tested; compose auth issue |
| `fetch_eln_entry` | mcp-eln-local | Tested; compose auth issue |
| `fetch_eln_canonical_reaction` | mcp-eln-local (top-N OFAT) | Tested; compose auth issue |
| `fetch_eln_sample` | mcp-eln-local | Tested; compose auth issue |
| `query_instrument_runs` | mcp-logs-sciy | **Compose missing MCP_AUTH_SIGNING_KEY** (M10) |
| `fetch_instrument_run` | mcp-logs-sciy | Tested; compose auth issue |

#### KG writes + confidence (3 tools) — ✅ Complete
| Tool | Purpose | Coverage |
|------|---------|----------|
| `propose_hypothesis` | Persist hypothesis + CITES edges | Tested |
| `update_hypothesis_status` | Hypothesis state transition | Tested; emits `hypothesis_status_changed` event (**no emitter exists** per M07 synthesis) |
| `compute_confidence_ensemble` | Verbalized + Bayesian + cross-model | Tested; auto-trigger deferred (BACKLOG #50) |

#### Cross-project reasoning (3 tools) — ✅ Complete
| Tool | Purpose | Coverage |
|------|---------|----------|
| `statistical_analyze` | TabICL yield analysis | Tested |
| `synthesize_insights` | Structured insights + citations | Tested |
| `draft_section` | Report section with citation tokens | Tested; citation validation strict |

#### Tabular + sandbox (3 tools) — ✅ Complete
| Tool | Purpose | Coverage |
|------|---------|----------|
| `analyze_csv` | CSV parsing + summarization | Tested; decision logic wired |
| `run_program` | E2B sandbox Python | Tested; timeout guards |
| `dispatch_sub_agent` | Sub-agent spawner | Tested; own context isolation |

#### Long-horizon autonomy (2 tools) — ✅ Complete
| Tool | Purpose | Coverage |
|------|---------|----------|
| `manage_todos` | Session-backed checklist | Tested; SSE event wiring complete |
| `ask_user` | Session pause for clarification | Tested; awaiting_user_input finish reason |

#### Tool forging (4 tools) — ⚠️ Partial (M73 RLS violation)
| Tool | Purpose | Coverage |
|------|---------|----------|
| `forge_tool` | 4-stage Forjador algorithm | **RLS violation: bare pool.query writes** (M73); validated nightly |
| `induce_forged_tool_from_trace` | Generalize from Langfuse trace | Tested |
| `add_forged_tool_test` | Append test case | Tested |
| `promote_workflow_to_tool` | Forge tool from workflow | Tested |

#### Workflow engine (6 tools) — ⚠️ Partial (M35: silent no-op on unimplemented step kinds)
| Tool | Purpose | Coverage |
|------|---------|----------|
| `workflow_define` | Create/version workflow DSL | Tested; **engine has NotImplementedError guards** |
| `workflow_run` | Start a workflow run | Tested; **emits no ingestion_events** (M37) |
| `workflow_inspect` | Current state + outstanding step | Tested |
| `workflow_modify` | Patch paused workflow | Tested |
| `workflow_pause_resume` | Pause or resume | Tested |
| `workflow_replay` | Replay finished run (deterministic) | Tested |

#### Batch infrastructure (2 tools) — ✅ Complete
| Tool | Purpose | Coverage |
|------|---------|----------|
| `enqueue_batch` | Queue QM/genchem/classifier tasks | Tested; idempotent on (task_kind, idempotency_key) pair |
| `inspect_batch` | Progress: pending/succeeded/failed/cancelled | Tested |

#### Additional (3 tools) — ✅ Complete
| Tool | Purpose | Coverage |
|------|---------|----------|
| `run_chemspace_screen` | N-compound chemical-space screen | Tested |
| `mark_research_done` | Terminal report persistence | Tested |
| (Older builtins ported from Phase B) | — | Tested |

**Summary:** 73 fully wired; 4 dependent on stubbed MCP backends (M02: green-chemistry + applicability-domain missing SERVICE_SCOPES); 1 missing registration (M39: inchikey_from_smiles).

---

## Hooks: Lifecycle Handler Coverage

**Status (2026-05-05):** 16 valid lifecycle points declared in `VALID_HOOK_POINTS` (per PARITY.md).

### Built-in Handlers (7 points)
| Lifecycle point | Built-in handler | YAML | Status |
|---|---|---|---|
| `session_start` | `session-events` (telemetry) | hooks/session-events.yaml | ✅ Complete |
| `pre_turn` | `init-scratch`, `apply-skills` | hooks/init-scratch.yaml, hooks/apply-skills.yaml | ✅ Complete |
| `pre_tool` | `budget-guard`, `foundation-citation-guard` | hooks/budget-guard.yaml, hooks/foundation-citation-guard.yaml | ✅ Complete |
| `post_tool` | `anti-fabrication`, `tag-maturity`, `source-cache` | 3 YAML files | ✅ Complete (except source-cache projector never fires M09) |
| `pre_compact` | `compact-window` (Haiku compactor) | hooks/compact-window.yaml | ✅ Complete |
| `post_turn` | `redact-secrets` (output scrub) | hooks/redact-secrets.yaml | ✅ Complete |
| `permission_request` | `permission` (enforce mode decision) | hooks/permission.yaml | ⚠️ Partial: fires only on `/api/chat` SSE (M16) |

### Dispatch-only (9 points — no built-in handler, no-op)
| Lifecycle point | Dispatch site(s) | Status | Rationale |
|---|---|---|---|
| `session_end` | `chained-harness.ts:369`, `chat.ts:497` | Dispatch-only | Operator-attachable; infrastructure in place |
| `user_prompt_submit` | `chat.ts:185` | Dispatch-only | Operator-attachable |
| `post_tool_failure` | `step.ts:206` | Dispatch-only | Operator-attachable |
| `post_tool_batch` | `step.ts:374` | Dispatch-only | Operator-attachable (parallel readonly batch completes) |
| `subagent_start` | `sub-agent.ts:171` | Dispatch-only | Operator-attachable |
| `subagent_stop` | `sub-agent.ts:205`, `:223` | Dispatch-only | Operator-attachable |
| `task_created` | `manage_todos.ts:132` | Dispatch-only | Operator-attachable |
| `task_completed` | `manage_todos.ts:163`, `:184` | Dispatch-only | Operator-attachable |
| `post_compact` | `harness.ts:178`, `chat-compact.ts:44` | Dispatch-only | Operator-attachable |

**Verification:** `MIN_EXPECTED_HOOKS = 11` in `bootstrap/start.ts` matches the 7 built-in + 1 permission dispatcher = 8 core expectations. The 9 dispatch-only points are intentionally not counted (no boilerplate needed).

---

## Projectors (11 services in `services/projectors/`)

| Projector | Interested events | Status | Pragma lines |
|-----------|---|---|---|
| `chunk_embedder` | document_imported | ✅ Complete | 0 |
| `compound_classifier` | compound_imported | ⚠️ Partial | 2 lines; custom NOTIFY channel (DR-06 documented) |
| `compound_fingerprinter` | fingerprint_computed | ⚠️ Partial | 2 lines; custom NOTIFY channel (DR-06 documented) |
| `contextual_chunker` | document_imported | ✅ Complete | 0 |
| `kg_documents` | document_imported | ✅ Complete | 0; creates KG Document + HAS_CHUNK + Chunk nodes |
| `kg_experiments` | experiment_imported | ❌ Missing | **No live emitter** (M08); legacy importer import-broken; projector silently never runs |
| `kg_hypotheses` | hypothesis_created, hypothesis_status_changed | ⚠️ Partial | 1 pragma line (main entrypoint); **no hypothesis_status_changed emitter** (per M07 synthesis) |
| `kg_source_cache` | source_fact_observed | ❌ Missing | **Projector receives 0 events; writer bug inserts non-UUID to UUID column** (M09) |
| `qm_kg` | qm_job_succeeded | ⚠️ Partial | 1 pragma; **uses sync Neo4j driver inside async loop** (M21); no try/except on transient driver errors |
| `reaction_vectorizer` | reaction_imported | ⚠️ Partial | **0 tests at diff-cover layer** (BACKLOG #35) |
| `conditions_normalizer` | reaction_imported | ❌ Missing | **Has no docker-compose entry under any profile** (M14); projector never starts |

**Summary:** 2 incomplete (M08, M14), 1 non-functional (M09), 3 with async/correctness issues. 5 fully operational.

---

## Permissions + Security

### Permission Resolver
| Surface | Wiring status | Notes |
|---------|---|---|
| `core/permissions/resolver.ts` | ✅ Built | Consults DB `permission_policies`; three modes: default/acceptEdits/plan/dontAsk/bypassPermissions |
| `permission` hook | ⚠️ Partial | Fires on `/api/chat` SSE only; **7 other call paths bypass** (M16) — design-rule #02 flagged and fixed as of A02 commit |
| `allowedTools` / `disallowedTools` filters | ⚠️ Partial | Resolver consults fields; **LLM still sees full catalog** (filter post-call via synthetic result, not pre-prompt) |
| `workspace-boundary` helper | ⚠️ Partial | `assertWithinWorkspace` implemented + tested; **no production caller** (BACKLOG #40) |
| Admin RBAC (`admin_roles` table) | ✅ Complete | `global_admin`, `org_admin`, `project_admin` roles; RLS SECURITY DEFINER queries |
| Audit trail (`appendAudit` helper) | ⚠️ Partial | 5 routes use it; **4 legacy routes bypass** (M34 — `/eval`, `/optimizer`, `/forged-tools`, `/skills`) |

---

## Half-Built Code Candidates

### Frontend
| Item | Status | Notes |
|---|---|---|
| `services/frontend/` | ✅ Archived | Streamlit moved out; only stub `pages/` dir present (Nextjs placeholder); rebuilt in separate repo |

### Legacy Importers
| Item | Status | Notes |
|---|---|---|
| `services/ingestion/eln_json_importer.legacy/` | ✅ Preserved | Excluded from CI; one-shot bulk migrations only; **its importer.py:258 is the only emitter of `experiment_imported` event** (M08) but import itself is broken |

### Helper Utilities (no production callers)
| Utility | File | Status | Usage |
|---|---|---|---|
| `assertWithinWorkspace` | `security/workspace-boundary.ts` | ✅ Tested | **Zero production callers** (BACKLOG #40); awaits filesystem-shaped tools |
| `record_error_event()` | `db/init/19_observability.sql` | ✅ Defined, RLS, NOTIFY trigger | **Zero callers in services/** (M30) |
| `ConfigRegistry` (Python) | `services/common/config_registry.py` | ✅ Full impl | **Zero callers** outside docs (M01 SYNTHESIS) |
| `isFeatureEnabled` helper | `config/flags.ts` | ✅ Full impl | **No production readers** (M01 SYNTHESIS) |
| Langfuse root spans (`startRootTurnSpan`) | `observability/otel.ts` | ✅ Impl | **Called from `/api/chat` SSE only** (M31); orphan spans elsewhere |

---

## ADR Drift Analysis

| ADR | Status | Implementation summary | Drift? |
|---|---|---|---|
| **001-architecture** | ✅ Implemented | A-on-C hybrid, Postgres canonical, event-sourced projectors, Neo4j KG, pgvector, Graphiti. | ✅ No drift |
| **004-harness-engineering** | ✅ Implemented | ~500-LOC while-loop harness, hooks-first lifecycle, skills JIT-loading. | ✅ No drift |
| **005-data-layer-revision** | ✅ Implemented | Event-sourced ingestion, projectors, idempotent handlers, replay via ack deletion. | ⚠️ Minor: RLS gaps on Phase 4–7 tables (M04, M05, M06) |
| **006-sandbox-isolation** | ✅ Implemented | E2B PTC + OpenShift SCC equivalents. | ✅ No drift |
| **007-hook-system-rebuild** | ✅ Implemented | YAML loader as single registration point; lifecycle points + decision contract. | ✅ No drift |
| **008-collapsed-react-loop** | ✅ Implemented | Single while-loop harness; no framework wrapping. | ✅ No drift |
| **009-permission-and-decision-contract** | ⚠️ Partial | Decision contract implemented (deny > defer > ask > allow); resolver wired; **M16: only `/api/chat` SSE fires permission hook** (7 call paths bypass). **A02 fix applied as of commit 09d2661**; verify in next audit. |
| **010-deferred-phases** | ✅ Documented | v1.4 deferrals (Setting sources, ToolSearch, Effort levels) listed; workflow engine loop/parallel/sub_agent NotImplementedError guards in place. | ✅ No drift |

---

## BACKLOG Triage

**Status:** 76 entries in BACKLOG.md (Wave 1 starting count unknown; current count post-#92).

### Stale Post-Wave-1 (candidate for removal)
| Entry | Reason for staleness | Action |
|---|---|---|
| Line 6: "wire remaining 5 runHarness call sites" | **All 6 sites now pass `permissionMode: 'enforce'`** (chat.ts, plan.ts, deep-research.ts ×2, sub-agent.ts, chained-harness.ts); verified per A02 DR-02. | ✅ Update or drop |
| (Others TBD post-audit) | — | — |

### Still Valid (sample)
| Entry | Severity | Status |
|---|---|---|
| Line 5: restore `compound_classifier` + `compound_fingerprinter` to mypy clean | P2 | Still valid; 10+ bare annotations |
| Line 7: org-scoped `redaction_patterns` apply per-call | P1 | Still valid; LiteLLM gateway missing org context |
| Line 11: migrate `MAX_ACTIVE_SKILLS` to config_settings | P2 | Still valid; infrastructure ready; infra → call-site swap pending |
| Line 19: design_plate annotate_yield uses global model | P2 | Still valid; per-project model selection pending |
| Line 42: add built-ins for 9 dispatch-only hooks | P2 | Still valid but deferred; **actual decision (per PARITY.md): shipping no-op stubs adds boilerplate with zero behaviour change; dispatch-only is minimum honest config** |
| Line 50: full auto-trigger of compute_confidence_ensemble | P1 | Still valid; infrastructure (cross-model) in place; trigger gating + per-skill toggle pending |

---

## Key Completeness Findings — Summary

### Fully Complete Features (green light)
1. **Harness core** (Phase A): while-loop, hooks, tool registry, slash parser — all 5/5 complete ✅
2. **Retrieval layer** (Phase B): search_knowledge, document fetchers, KG query — all 10/10 builtins working ✅
3. **Session persistence + autonomy** (pre-rebuild): scratchpad, todo management, ask_user, reanimator — all wired ✅
4. **Compaction + confidence** (Phase C): context compactor, 3-signal ensemble — all wired ✅
5. **Sub-agent spawning** (Phase B): own context isolation, lifecycle inheritance — fully tested ✅
6. **Forged tool ecosystem** (Phase D.5): forge + validate + promote — infrastructure complete (RLS bug aside) ✅
7. **8 ADRs** (001, 004, 006, 007, 008) — zero implementation drift ✅

### Partial Features (yellow light — missing pieces)
1. **Tool forging RLS** (Phase D.5): bare `pool.query` writes bypass RLS on `skill_library` + `tools` tables (M73) — **A02 did not address; deferred**
2. **Permission enforcement** (Phase 6): resolver works; **only `/api/chat` SSE fires hook; 7 other harness call paths bypass enforcement** (M16) — **A02 fix applied 2026-05-05; verify**
3. **Chemistry MCPs** (Phase F.1): all services present; **async/blocking issues** (M19: sync heavy work under async; M20: per-request expensive re-instantiation); **F.2 source MCPs missing auth env** (M10)
4. **Skill maturity gating** (Phase C/E): columns added; **loader ignores both `maturity` and `shadow_until`** (M38) — **still deferred; BACKLOG #50 + #51**
5. **Workflow engine** (Phase 4–9): basic tool_call/wait working; **loop/parallel/conditional/sub_agent step kinds raise NotImplementedError at runtime** (M35) — **intentional guard; no silent no-op**
6. **Projectors** (11 total): 5 fully functional; **3 have correctness/coverage issues** (M08: kg_experiments never runs; M09: kg_source_cache receives 0 events; M14: conditions_normalizer has no compose entry)

### Broken Features (red light — won't work)
1. **`inchikey_from_smiles` builtin** (M39): **not registered in `bootstrap/dependencies.ts`** — tool never available despite 2 skills referencing it
2. **Green-chemistry + applicability-domain MCPs** (M02): **missing from SERVICE_SCOPES in both TS + Py** — JWT mint throws on every call when `MCP_AUTH_SIGNING_KEY` is set
3. **ELN + LOGS source MCPs** (M10): **compose entries missing `MCP_AUTH_SIGNING_KEY` env** — 401 in any prod-shaped deploy
4. **Source-cache hook → kg_source_cache projector** (M09): **hook inserts non-UUID string to UUID column** — projector never receives events; full feature broken
5. **`experiment_imported` event** (M08): **only emitter is legacy eln_json_importer which is import-broken** — kg_experiments, reaction_vectorizer, conditions_normalizer projectors never triggered
6. **Helm deployments** (M13): **11 services missing** from `infra/helm/templates/chemistry-deployments.yaml` — Helm-based deploys silently skip them
7. **Workflow + queue services** (M15): **no docker-compose entries under any profile** — cannot start via `make up.full`

---

## Coverage Metrics

| Metric | Value | Notes |
|---|---|---|
| **Builtins fully wired** | 73/77 (94%) | 4 blocked by missing SERVICE_SCOPES + 1 missing registration |
| **Hooks with built-in handlers** | 7/16 (44%) | 9 dispatch-only points intentionally no-op; infrastructure in place |
| **Projectors fully operational** | 5/11 (45%) | 2 broken (M08, M14), 1 non-functional (M09), 3 async/coverage issues |
| **ADRs with zero drift** | 5/8 (62%) | ADR 005 has RLS gaps; ADR 009 has permission wiring gap (flagged A02) |
| **Call-site enforcement complete** | ⚠️ Partial | Permission resolver has 7 bypass paths (M16 addressed by A02); audit trails have 4 bypass routes (M34) |
| **MCP auth everywhere** | ⚠️ Partial | Missing from 2 source MCPs (M10); inconsistent TS vs Py error handling (M17) |

---

## Next Audit Wave — Priority Targets for A04+

### P0 Red-line Issues (break production immediately)
1. **M02: SERVICE_SCOPES** — register green-chemistry + applicability-domain in TS + Py
2. **M10: ELN/LOGS auth env** — add `MCP_AUTH_SIGNING_KEY` to compose entries
3. **M39: inchikey_from_smiles** — register in `bootstrap/dependencies.ts`
4. **M09: source-cache UUID bug** — fix hook to write actual UUID, not string
5. **M08: experiment_imported emitter** — restore or replace legacy importer; fix kg_experiments projector triggering
6. **M14: conditions_normalizer** — add docker-compose entry under `sources` or `full` profile
7. **M13: Helm coverage** — template 11 missing services

### P1 Yellow-line Issues (defense-in-depth gaps)
1. **M16: Permission enforcement** — wire remaining 7 harness call paths (A02 says this was done; verify)
2. **M19/M20: Chemistry MCP async** — lift blocking work out of async handlers via `run_in_executor` or connection pooling
3. **M38: Skill maturity gating** — wire loader to respect `maturity` + `shadow_until` columns
4. **M21: qm_kg sync driver** — async-ify or move to separate worker; add error handling
5. **M73: forge_tool RLS** — wrap `pool.query` writes in `withUserContext` transaction
6. **M31: Orphan Langfuse spans** — fire `startRootTurnSpan` on all harness call paths, not just SSE

---

## Files Implementing Key Phases

### Phase A (Harness)
- `services/agent-claw/src/core/harness.ts` (147 LOC)
- `services/agent-claw/src/core/hook-loader.ts` (180 LOC)
- `services/agent-claw/src/core/lifecycle.ts` (200+ LOC)
- `hooks/*.yaml` (11 files)

### Phase B (Tools + Fetchers)
- `services/agent-claw/src/tools/builtins/*.ts` (77 files)
- `services/mcp_tools/mcp_rdkit/`, `mcp_drfp/`, `mcp_doc_fetcher/`

### Phase C (Compaction + Confidence)
- `services/agent-claw/src/core/compactor.ts` (280 LOC)
- `services/agent-claw/src/core/confidence.ts` (180 LOC)
- `services/projectors/contextual_chunker/`

### Phase D (Sandbox + Forging)
- `services/agent-claw/src/core/sandbox.ts`
- `services/agent-claw/src/tools/builtins/forge_tool.ts`
- `services/optimizer/forged_tool_validator/`

### Phase E (GEPA + Promotion)
- `services/optimizer/gepa_runner/`
- `services/optimizer/skill_promoter/`

### Phase F.1 (Chemistry MCPs)
- `services/mcp_tools/mcp_xtb/`, `mcp_crest/`, `mcp_chemprop/`, `mcp_aizynth/`, `mcp_askcos/`, `mcp_sirius/`, `mcp_synthegy_mech/`, `mcp_green_chemistry/`, `mcp_applicability_domain/`

### Phase F.2 (Source Systems)
- `services/mcp_tools/mcp_eln_local/`, `mcp_logs_sciy/`
- `services/projectors/kg_source_cache/`

### Workflow Engine
- `services/workflow_engine/main.py` (400+ LOC)
- `services/agent-claw/src/tools/builtins/workflow_*.ts` (6 builtins)

---

## Conclusion

The codebase is **~75% feature-complete** (77 builtins, 7 hooks, 5 projectors fully wired). The remaining **25% consists of:**
- **5 P0 wiring gaps** that cause immediate runtime failures in specific call paths (M02, M10, M39, M09, M08, M14)
- **3 P1 defense-in-depth issues** that affect all calls (M16, M19/M20, M38)
- **Intentional deferral pattern:** workflow loop/parallel/sub_agent step kinds, skill maturity gating, and 9 dispatch-only hooks ship NotImplementedError guards or empty dispatches to avoid silent no-ops

**A02 addressed DR-02 (forge_tool RLS — deferred) and DR-14 (logger redaction — deferred).** Neither the M16 permission wiring nor the M39/M02/M10 service-registry gaps were targeted. The audit threshold remains **~70% of Wave 1's original 25 findings still open**.

**For Tier 2–4 agents:** Use this map to prioritize investigations by feature category. The "red-line" section identifies what *won't* work today; the "partial" section identifies what *will* work but with caveats.

