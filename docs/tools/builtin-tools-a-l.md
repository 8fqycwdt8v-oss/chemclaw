# ChemClaw Builtin Tools Reference — A through L

This document covers all builtin agent tools with names beginning A–L. For tools M–Z see [builtin-tools-m-z.md](builtin-tools-m-z.md). Builtin tools are TypeScript functions defined in `services/agent-claw/src/tools/builtins/` via `defineTool({ id, description, inputSchema, outputSchema, annotations })`.

**Schema validation:** All inputs are validated by Zod before `execute()` runs. Type errors return a structured error to the agent, not an exception. Outputs are also schema-validated.

**Annotation key:**
- `readOnly: true` — No state mutations to Postgres or any downstream system
- `readOnly: false` — May INSERT/UPDATE or call state-mutating MCP endpoints

**Tool count (A–L):** 52 tools

---

### add_forged_tool_test

**Tool ID:** `add_forged_tool_test`

**Description:** Append a persistent test case to an existing forged tool in `forged_tool_tests`. Only the tool's owner (the user whose `proposed_by_user_entra_id` matches the skill_library row) can add tests. `kind` must be one of: `functional` (default), `contract`, `property`.

**Annotations:** `readOnly: false`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `forged_tool_id` | `string` (UUID) | Yes | Must be a valid UUID | — | UUID of the forged tool (from `skill_library`) to attach the test to |
| `input_json` | `Record<string, unknown>` | Yes | Non-null object | — | Test input payload |
| `expected_output_json` | `Record<string, unknown>` | Yes | Non-null object | — | Expected output to compare against |
| `tolerance_json` | `Record<string, number (≥0)>` | No | All values must be non-negative numbers | — | Per-key numeric tolerance for floating-point comparisons |
| `kind` | `"functional" \| "contract" \| "property"` | No | — | `"functional"` | Test type |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `test_id` | `string` (UUID) | Newly inserted test case ID |
| `forged_tool_id` | `string` (UUID) | UUID of the parent forged tool |
| `kind` | `string` | Test kind that was stored |

**Notes:** Runs inside a single `withUserContext` transaction so the ownership check and INSERT are atomic. Throws if the tool is not found or the caller is not the owner.

---

### add_synthesis_campaign_step

**Tool ID:** `add_synthesis_campaign_step`

**Description:** Append one step to an existing synthesis campaign's DAG. Use when the per-kind playbook needs an extra step, when the campaign was created with `seed_playbook=false`, or when a BO campaign needs another `bo_round`.

**Annotations:** `readOnly: false`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `campaign_id` | `string` (UUID) | Yes | Valid UUID | — | Target campaign |
| `kind` | `StepKind` enum | Yes | One of: `retrosynthesis`, `literature_pull`, `condition_design`, `library_design`, `hte_plate_design`, `bo_round`, `forward_prediction`, `qm_screen`, `mechanism_check`, `feasibility_assessment`, `submit_batch`, `measurement_wait`, `ingest_results`, `readiness_gate`, `die_check`, `summary` | — | Step kind to add |
| `inputs` | `JsonRecord` | No | Depth-2 JSON object | `{}` | Initial step inputs |
| `notes` | `string` | No | max 2000 chars | — | Free-text notes |
| `depends_on` | `string[]` (UUIDs) | No | max 20 elements, each a valid step UUID within the same campaign | `[]` | UUIDs of steps that must be completed before this step can start |
| `ref_table` | `string` | No | 1–100 chars | — | Name of a table this step references (e.g. `optimization_rounds`) |
| `ref_id` | `string` | No | 1–200 chars | — | ID within `ref_table` |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `step` | `StepSummary` | The inserted step record (see StepSummary shape below) |

**StepSummary shape:** `id` (UUID), `step_index` (int), `kind` (StepKind), `status` (StepStatus), `ref_table` (string|null), `ref_id` (string|null), `depends_on` (UUID[]), `notes` (string|null), `started_at` (ISO string|null), `completed_at` (ISO string|null), `inputs` (JsonRecord), `outputs` (JsonRecord).

**Notes:** Atomically increments `synthesis_campaigns.total_steps` and bumps `etag`. Inserts a `step_added` event in `synthesis_campaign_events`.

---

### advance_synthesis_campaign

**Tool ID:** `advance_synthesis_campaign`

**Description:** Pick the next pending step of a synthesis campaign whose dependencies are all satisfied, claim it (`status → in_progress`) by default, and return tool-hints for the orchestrator. Also flips the campaign to `completed` or `died` when appropriate. Returns one of: `next_step` | `no_ready_steps` | `campaign_completed` | `campaign_died` | `campaign_terminal`.

**Annotations:** `readOnly: false`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `campaign_id` | `string` (UUID) | Yes | Valid UUID | — | Campaign to advance |
| `claim` | `boolean` | No | — | `true` | If true, transitions the picked step to `in_progress` before returning to prevent duplicate picks under concurrency |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `decision` | `"next_step" \| "no_ready_steps" \| "campaign_completed" \| "campaign_died" \| "campaign_terminal"` | Routing outcome |
| `campaign_id` | `string` (UUID) | Echoed campaign ID |
| `campaign_status` | `CampaignStatus` | Current campaign status after any transitions |
| `step` | `StepSummary \| null` | The claimed step, or null if no step was picked |
| `recommended_tools` | `string[]` | Builtin/skill names the orchestrator should call next |
| `rationale` | `string` | Human-readable explanation of the decision |

**Notes:** For `bo_or_die` campaigns, evaluates the die-gate (consecutive rounds without improvement, or budget exhaustion) before picking the next step. Uses `SELECT ... FOR UPDATE` to prevent race conditions.

---

### analyze_csv

**Tool ID:** `analyze_csv`

**Description:** Parse and summarize tabular CSV data. Supply either `document_id` (a UUID from the `documents` table) or `csv_text` (raw CSV string, max 1 MB). Returns row count, per-column summary (type, min/max/mean, missing count), and an answer to a free-text query. If `answer_to_query` is `"__llm_judgement_required__"`, call `synthesize_insights` next.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `document_id` | `string` (UUID) | Conditional | Valid UUID; mutually exclusive with `csv_text` | — | UUID of a document in the `documents` table; the original CSV is fetched via mcp-doc-fetcher |
| `csv_text` | `string` | Conditional | max 1,048,576 bytes (1 MB); mutually exclusive with `document_id` | — | Raw CSV content |
| `query` | `string` | Yes | 1–1000 chars | — | Free-text question to answer about the data |

Exactly one of `document_id` or `csv_text` must be provided; supplying both or neither throws.

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `row_count` | `number` | Number of data rows (excluding header) |
| `column_summary` | `ColumnSummary[]` | Per-column statistics |
| `answer_to_query` | `string` | Answer to the query, or `"__llm_judgement_required__"` if LLM reasoning is needed |

**ColumnSummary shape:** `name` (string), `type` ("number" \| "string" \| "date"), `min` (number, numeric columns only), `max` (number, numeric columns only), `mean` (number, numeric columns only), `n_missing` (number).

**Notes:** Simple queries (row counts, column lists, min/max/mean/range, threshold filters) are answered by direct computation without an LLM call. The `"__llm_judgement_required__"` sentinel signals when an LLM call is needed.

---

### ask_user

**Tool ID:** `ask_user`

**Description:** Pause the agent and ask the user a clarifying question. Use **only** when the agent genuinely cannot proceed without input — ambiguous requirements, multiple equally-valid options, or missing context that would change the approach. After this tool fires, the SSE stream ends with `finishReason="awaiting_user_input"`. The user's next message resumes the session with their answer threaded into history.

**Annotations:** `readOnly: false`, `is_internal: true` (never extracted into the KG)

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `question` | `string` | Yes | 1–2000 chars, plain text, no markdown | — | Clarifying question to surface to the user |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `awaiting` | `true` (literal) | Always `true`; signals the awaiting state |
| `question` | `string` | The question that was stored |

**Notes:** This tool does not return normally — it throws `AwaitingUserInputError`, which the harness loop catches to persist the session state and emit the `awaiting_user_input` SSE event. Resume requires a POST to `/api/chat` with the same `session_id` and the user's answer.

---

### assess_applicability_domain

**Tool ID:** `assess_applicability_domain`

**Description:** Three-signal applicability-domain (AD) verdict for a reaction: Tanimoto nearest-neighbor in DRFP space, Mahalanobis distance in feature space, and conformal-prediction interval width. Returns the verdict (`"in_domain"` / `"borderline"` / `"out_of_domain"`) plus all underlying scores. The verdict is annotate-don't-block: descriptive only; chemists still see every recommendation.

**Annotations:** `readOnly: true`, `result_schema_id: "assess.v1"`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `rxn_smiles` | `string` | Yes | 3 – `MAX_RXN_SMILES_LEN` chars | — | Reaction SMILES to assess (reactants>>products format) |
| `project_internal_id` | `string` | No | max 200 chars | — | NCE project ID for project-scoped calibration data; falls back to cross-project pool when not provided or the pool is too small (< 30 reactions) |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `verdict` | `"in_domain" \| "borderline" \| "out_of_domain"` | Aggregated AD verdict |
| `tanimoto_signal` | object | `distance`, `tanimoto`, `threshold_in`, `threshold_out`, `in_band` |
| `mahalanobis_signal` | object | `mahalanobis`, `threshold_in`, `threshold_out`, `in_band`, `stats_version`, `n_train` |
| `conformal_signal` | object \| null | `alpha`, `half_width`, `calibration_size`, `used_global_fallback`, `threshold_in`, `threshold_out`, `in_band`; null when calibration pool < 30 reactions |
| `used_global_fallback` | `boolean` | Whether the cross-project calibration pool was used |

**Notes:** Cross-project bootstrap fallbacks are audited via `appendAudit` with action `ad.cross_project_bootstrap_used`. On a 404 cache miss from the `/assess` endpoint, the tool automatically re-calibrates and retries once. Service call chain: mcp-drfp → pgvector NN search → mcp-chemprop → mcp-applicability-domain.

---

### canonicalize_smiles

**Tool ID:** `canonicalize_smiles`

**Description:** Canonicalize a SMILES string via RDKit. Returns canonical SMILES, InChIKey, molecular formula, and molecular weight.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `smiles` | `string` | Yes | 1–10,000 chars | — | Input SMILES string (any valid RDKit-parseable SMILES) |
| `kekulize` | `boolean` | No | — | — | If true, returns Kekulé form instead of aromatic notation |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `canonical_smiles` | `string` | RDKit canonical SMILES string |
| `inchikey` | `string` | Standard InChIKey (27-character hash) |
| `formula` | `string` | Molecular formula (e.g. `C9H8O4`) |
| `mw` | `number` | Molecular weight in g/mol |

**Notes:** Delegates to mcp-rdkit `/tools/canonicalize_smiles`. Timeout: 10,000 ms.

---

### check_contradictions

**Tool ID:** `check_contradictions`

**Description:** Surface explicit `CONTRADICTS` edges and parallel current facts for an entity in the knowledge graph. Does not resolve contradictions — intended for deep research only. All returned `fact_ids` are harvested by the anti-fabrication `post_tool` hook.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `entity` | object | Yes | — | — | Entity to query |
| `entity.label` | `string` | Yes | 1–80 chars, must match `^[A-Z][A-Za-z0-9_]*$` | — | KG node label (e.g. `Reaction`, `Compound`) |
| `entity.id_property` | `string` | Yes | 1–40 chars, must match `^[a-z][a-z0-9_]*$` | — | Property name for the ID (e.g. `id`, `inchikey`) |
| `entity.id_value` | `string` | Yes | 1–4000 chars | — | Value of the ID property |
| `predicate` | `string` | No | 1–80 chars, must match `^[A-Z][A-Z0-9_]*$` | — | If provided, filter to contradictions on this predicate only |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `contradictions` | `Contradiction[]` | List of detected contradictions |
| `surfaced_fact_ids` | `string[]` (UUIDs) | All fact IDs surfaced, for anti-fabrication tracking |

**Contradiction shape:** `kind` (`"explicit_contradicts_edge"` \| `"parallel_current_facts"`), `predicate` (string), `fact_ids` (UUID[], min 1), `summary` (string).

**Notes:** Issues two KG queries: one for current outbound facts filtered by predicate, and one for explicit `CONTRADICTS` edges (including invalidated) in both directions. Parallel current facts are detected when two or more currently-valid edges share the same predicate but point to different objects.

---

### classify_compound

**Tool ID:** `classify_compound`

**Description:** Return the assigned role(s) and chemotype family(s) for a SMILES. Fast path: lookup in `compound_class_assignments` (populated by the `compound_classifier` projector). Slow path: live SMARTS catalog match. Useful for "what is this compound?" and for filtering screens by role.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `smiles` | `string` | Yes | 1–10,000 chars | — | SMILES of the compound to classify |
| `inchikey` | `string` | No | — | — | Optional InChIKey. When provided, the fast path (database lookup) is taken. When omitted, an empty classes array is returned and the agent should call `inchikey_from_smiles` first |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `inchikey` | `string \| null` | Resolved InChIKey, or null if none was provided |
| `smiles` | `string` | Input SMILES echoed back |
| `classes` | object[] | Classification results |
| `classes[].name` | `string` | Class name (from `compound_classes`) |
| `classes[].role` | `string` | Functional role (e.g. catalyst, substrate, product) |
| `classes[].family` | `string \| null` | Chemotype family, if assigned |
| `classes[].confidence` | `number` | Classification confidence score |
| `classes[].source` | `"assignment" \| "live_smarts"` | Whether result came from DB or live matching |

**Notes:** When called without `inchikey`, logs a warning and returns empty classes rather than making an mcp-rdkit call. Use `inchikey_from_smiles` or `canonicalize_smiles` first to get the InChIKey if you only have SMILES.

---

### compute_confidence_ensemble

**Tool ID:** `compute_confidence_ensemble`

**Description:** Compute a confidence ensemble (verbalized + Bayesian + cross-model signals) for an artifact previously persisted this turn. Stores the result in `artifacts.confidence_ensemble` and returns the ensemble breakdown plus a categorical `confidence_label` (`foundational` | `high` | `medium` | `low`).

**Annotations:** `readOnly: false`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `artifact_id` | `string` (UUID) | Yes | Valid UUID | — | UUID of the artifact to score; must not be superseded |
| `kg_prior` | object | No | — | — | KG prior counts for Beta-Binomial Bayesian posterior |
| `kg_prior.successes` | `integer` | Conditional | ≥ 0 | — | Number of positive outcomes in prior |
| `kg_prior.total` | `integer` | Conditional | ≥ 1, must be ≥ `successes` | — | Total count in prior |
| `cross_model_enabled` | `boolean` | No | — | `false` | If true, samples a second LLM for cross-model agreement (costs an extra LLM call) |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `artifact_id` | `string` (UUID) | Echoed artifact ID |
| `confidence_ensemble` | object | Full ensemble breakdown |
| `confidence_ensemble.verbalized` | `number \| null` | Self-reported confidence extracted from the artifact payload |
| `confidence_ensemble.cross_model` | `number \| null` | Cross-model agreement score (null if disabled or no LLM provider) |
| `confidence_ensemble.bayesian` | object \| null | `mean`, `ci_low`, `ci_high` from Beta-Binomial posterior; null if no prior provided |
| `confidence_ensemble.calibrated` | `number \| null` | Calibrated uncertainty from Chemprop-style std predictions |
| `confidence_ensemble.overall` | `number` | Weighted composite score (0–1) |
| `confidence_ensemble.confidence_label` | `"foundational" \| "high" \| "medium" \| "low"` | Categorical label |
| `confidence_ensemble.signals` | object[] | Per-signal breakdown: `name`, `score`, `weight`, `present` |
| `confidence_ensemble.brier_estimate` | `number` | Optional Brier score estimate |
| `persisted` | `boolean` | Whether the ensemble was successfully written to `artifacts.confidence_ensemble` |

**Notes:** Refuses to score superseded artifacts. Persistence is non-fatal: the computed ensemble is returned even if the UPDATE fails. Tenant-scoped thresholds are resolved from `config_settings`; falls back to defaults on DB unavailability.

---

### compute_conformer_ensemble

**Tool ID:** `compute_conformer_ensemble`

**Description:** Generate a Boltzmann-weighted conformer ensemble for a SMILES using GFN2-xTB + CREST. Use for stereo, atropisomerism, or ring-flip questions. Latency approximately 30–60 seconds.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `smiles` | `string` | Yes | 1–10,000 chars | — | SMILES of the molecule |
| `n_conformers` | `integer` | No | 1–100 | `20` | Maximum number of conformers to return from the CREST ensemble |
| `method` | `"GFN2-xTB" \| "GFN-FF"` | No | — | `"GFN2-xTB"` | Semi-empirical method for per-conformer geometry optimization |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `conformers` | object[] | List of conformer entries |
| `conformers[].xyz` | `string` | XYZ-format coordinates of the conformer |
| `conformers[].energy_hartree` | `number` | GFN2-xTB total energy in Hartree |
| `conformers[].weight` | `number` | Boltzmann population weight |

**Notes:** Convenience shim over `run_xtb_workflow` using the `optimize_ensemble` recipe. New code should prefer `run_xtb_workflow` directly for access to per-step timing and warnings. Default timeout is 1830 seconds (configurable via `config_settings` key `compute_conformer_ensemble.timeout_ms`).

---

### conformer_aware_kg_query

**Tool ID:** `conformer_aware_kg_query`

**Description:** Retrieve QM-anchored facts from the knowledge graph. Available queries: `compounds_with_calculation` (filter by method/task), `lowest_conformer_energy` (per InChIKey), `calculation_history_for_compound` (audit trail of QM jobs including bi-temporal `valid_from`/`valid_to`).

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `query` | `"compounds_with_calculation" \| "lowest_conformer_energy" \| "calculation_history_for_compound"` | Yes | — | — | Query type to execute |
| `inchikey` | `string` | Conditional | — | — | Required for `lowest_conformer_energy` and `calculation_history_for_compound`; optional filter for `compounds_with_calculation` |
| `method` | `string` | No | — | — | QM method filter (e.g. `GFN2-xTB`); applies to `compounds_with_calculation` |
| `task` | `string` | No | — | — | QM task filter (e.g. `conformers`, `frequencies`); applies to `compounds_with_calculation` |
| `limit` | `integer` | No | 1–200 | `20` | Maximum number of rows to return |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `query` | `string` | The query type that was executed |
| `rows` | `Record<string, unknown>[]` | Query-specific result rows |

**Row shapes by query type:**
- `compounds_with_calculation`: `inchikey`, `smiles_canonical`, `method`, `task`, `energy_hartree`, `converged`, `recorded_at`
- `lowest_conformer_energy`: `inchikey`, `smiles_canonical`, `lowest_energy_hartree`, `n_conformers`
- `calculation_history_for_compound`: `job_id`, `method`, `task`, `solvent_model`, `solvent_name`, `status`, `energy_hartree`, `valid_from`, `valid_to`, `recorded_at`

---

### design_plate

**Tool ID:** `design_plate`

**Description:** Design an HTE (high-throughput experimentation) plate (24/96/384/1536-well format) via BoFire space-filling DoE. Excluded solvents are dropped from the categorical input; the CHEM21 safety floor auto-drops HighlyHazardous solvents (override with `disable_chem21_floor`). Optionally annotates each well with predicted yield when `annotate_yield=true`.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `plate_format` | `"24" \| "96" \| "384" \| "1536"` | Yes | — | — | Well plate format |
| `n_wells` | `integer` | Yes | 1–1536, must not exceed `plate_format` capacity | — | Number of wells to design |
| `reactants_smiles` | `string` | No | 1 – `MAX_RXN_SMILES_LEN` chars | — | Reactant SMILES (used for yield annotation) |
| `product_smiles` | `string` | No | 1 – `MAX_SMILES_LEN` chars | — | Product SMILES (used for yield annotation) |
| `factors` | `ContinuousFactor[]` | No | max 10 elements | `[]` | Continuous experimental factors |
| `factors[].name` | `string` | Yes | 1–64 chars | — | Factor name |
| `factors[].type` | `"continuous"` (literal) | Yes | — | — | Factor type |
| `factors[].range` | `[number, number]` | Yes | — | — | `[min, max]` range |
| `categorical_inputs` | object[] | No | max 10 elements | `[]` | Categorical factor specifications |
| `categorical_inputs[].name` | `string` | Yes | 1–64 chars | — | Category name |
| `categorical_inputs[].values` | `string[]` | Yes | 1–200 elements, each 1–200 chars | — | Allowed values |
| `exclusions.solvents` | `string[]` | No | max 200 | `[]` | Solvents to exclude |
| `exclusions.reagents` | `string[]` | No | max 200 | `[]` | Reagents to exclude |
| `seed` | `integer` | No | — | `42` | Random seed for DoE reproducibility |
| `annotate_yield` | `boolean` | No | — | `false` | If true, call `predict_yield_with_uq` for yield annotation |
| `project_internal_id` | `string` | No | max 200 chars | — | Project context for yield prediction |
| `disable_chem21_floor` | `boolean` | No | — | `false` | If true, disable the CHEM21 safety filter on solvents |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `wells` | object[] | Designed wells: `well_id`, `rxn_smiles` (nullable), `factor_values` (record) |
| `domain_json` | `Record<string, unknown>` | BoFire domain specification used |
| `design_metadata` | `Record<string, unknown>` | DoE metadata (algorithm, seed, etc.) |
| `yield_summary` | object \| null | Present when `annotate_yield=true`; `ensemble_mean`, `ensemble_std`, `used_global_fallback` |

**Notes:** A cross-validation ensures `n_wells ≤ PLATE_CAPACITY[plate_format]` fails fast at the Zod layer. Yield enrichment is best-effort; plate design is the load-bearing output.

---

### dispatch_sub_agent

**Tool ID:** `dispatch_sub_agent`

**Description:** Spawn a specialized sub-agent to handle a focused sub-task. `type="chemist"` handles reaction similarity and KG queries. `type="analyst"` handles CSV analysis, knowledge search, and contradiction checks. `type="reader"` handles document retrieval, full-text, and original-doc access. Returns the sub-agent's answer, cited fact/doc/rxn IDs, and budget summary. Sub-agents run with their own `seenFactIds` and a fresh step budget (max 20 steps).

**Annotations:** `readOnly: false`, `is_internal: true` (never extracted into the KG)

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `type` | `"chemist" \| "analyst" \| "reader"` | Yes | — | — | Sub-agent specialization |
| `goal` | `string` | Yes | 1–2000 chars | — | Task description for the sub-agent |
| `inputs` | `Record<string, unknown>` | No | — | — | Structured context/data for the sub-agent |
| `max_steps` | `integer` | No | 1–20 | — | Step budget; defaults to the sub-agent type's default |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `type` | `string` | Sub-agent type echoed back |
| `text` | `string` | Sub-agent's answer text |
| `finish_reason` | `string` | Why the sub-agent stopped |
| `citations` | `string[]` | Fact/doc/reaction IDs cited by the sub-agent |
| `steps_used` | `number` | Number of ReAct steps consumed |
| `usage.prompt_tokens` | `number` | LLM prompt tokens used |
| `usage.completion_tokens` | `number` | LLM completion tokens used |

**Notes:** Sub-agent citations are merged into the parent's `seenFactIds` after the call, so the parent's anti-fabrication hook treats them as verified without requiring redundant tool calls.

---

### draft_section

**Tool ID:** `draft_section`

**Description:** Compose a report section. Validates inline citation tokens (`[exp:...]`, `[rxn:...]`, `[proj:...]`, `[doc:...]`, `[kg:...]`, `[unsourced]`). Returns formatted markdown with an audit trail of declared versus used citations.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `heading` | `string` | Yes | 1–400 chars | — | Section heading (rendered as `## heading`) |
| `evidence_refs` | `string[]` | Yes | max 200 elements; each must match `^\[(exp\|rxn\|proj\|doc\|kg\|unsourced)(:[^\]]{1,256})?\]$` | — | Pre-declared citation tokens |
| `body_markdown` | `string` | Yes | 1–40,000 chars | — | Section body with inline citation tokens |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `section_markdown` | `string` | The formatted section as `## heading\n\nbody` |
| `declared_refs` | `string[]` | Citations declared in `evidence_refs` |
| `used_refs` | `string[]` | Citations actually present in `body_markdown` |
| `undeclared_refs` | `string[]` | Citations used in the body but not declared (excluding `[unsourced]`) |
| `has_unsourced_claims` | `boolean` | Whether `[unsourced]` appears in the body |

**Notes:** Pure computation — no DB, no MCP calls. The citation regex is bounded to prevent ReDoS: kind is a fixed enum (max 10 chars), value limited to 256 chars.

---

### elucidate_mechanism

**Tool ID:** `elucidate_mechanism`

**Description:** Propose an electron-pushing reaction mechanism from reactants to products via LLM-guided A* search (Bran et al., Matter 2026). Returns intermediate SMILES with per-step LLM scores. Ionic chemistry only — radicals and pericyclic mechanisms are not supported. Optionally accepts a natural-language guidance prompt to bias the search.

**Annotations:** `readOnly: true`, `result_schema_id: "elucidate_mechanism.v1"`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `reactants_smiles` | `string` | Yes | 1 – `MAX_SMILES_LEN` chars | — | Reactant SMILES; multi-component separated by `.` (e.g. `CC=O.[OH-]`) |
| `products_smiles` | `string` | Yes | 1 – `MAX_SMILES_LEN` chars | — | Expected product SMILES |
| `max_nodes` | `integer` | No | 1–400 | `200` | Upper bound on A* nodes explored; paper demos use ~200 LLM calls per mechanism |
| `conditions` | `string \| null` | No | max 500 chars | — | Reaction conditions (acid, base, heat, catalyst); improves scoring |
| `guidance_prompt` | `string \| null` | No | max 4000 chars | — | Natural-language hint about the expected mechanism; materially improves quality |
| `validate_energies` | `boolean` | No | — | `false` | When true, validate intermediates via mcp-xtb GFN2-xTB single-point energies; adds 10–30 s per unique intermediate |
| `model` | enum | No | One of: `executor`, `planner`, `compactor`, `claude-sonnet-4-7`, `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5`, `gemini-2.5-pro`, `gpt-4o`, `deepseek-r1` | `"executor"` | LLM to use for scoring |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `moves` | `Move[]` | Sequence of arrow-pushing moves |
| `moves[].from_smiles` | `string` | SMILES before the move |
| `moves[].to_smiles` | `string` | SMILES after the move |
| `moves[].score` | `number` | LLM score 0–10 |
| `moves[].derived_kind` | `"i" \| "a" \| null` | Move kind: ionization (`i`) or attack (`a`) |
| `moves[].derived_atom_x` | `integer \| null` | Source atom index |
| `moves[].derived_atom_y` | `integer \| null` | Target atom index |
| `moves[].energy_delta_hartree` | `number \| null` | GFN2-xTB energy delta (present when `validate_energies=true`) |
| `reactants_smiles` | `string` | Echoed reactants |
| `products_smiles` | `string` | Echoed products |
| `total_llm_calls` | `integer` | Total LLM calls used |
| `total_nodes_explored` | `integer` | Total A* nodes explored |
| `prompt_tokens` | `integer` | Total prompt tokens |
| `completion_tokens` | `integer` | Total completion tokens |
| `parse_failures` | `integer` | Number of LLM responses that failed to parse |
| `upstream_errors` | `integer` | Number of upstream service errors |
| `warnings` | `string[]` | Any warnings (e.g. radical inputs detected) |
| `truncated` | `boolean` | Whether the mechanism was truncated at `max_nodes` |

**Notes:** Timeout: 300,000 ms (5 minutes). A mechanism deeper than 15 moves degrades in scoring quality. Cost: typical query is ~200 LLM calls (~$2–3 in tokens). The `stub` for `validate_energies` (GFN2-xTB binary not bundled) returns 501 in the current deployment.

---

### enqueue_batch

**Tool ID:** `enqueue_batch`

**Description:** Enqueue a batch of QM / genchem / classifier tasks. Returns `batch_id` for monitoring via `inspect_batch`. Idempotent — re-enqueuing the same `(task_kind, payload)` within the cluster is a no-op (returned in `duplicates`). Use to fan out chemspace screens or large library scoring runs.

**Annotations:** `readOnly: false`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `name` | `string` | Yes | 1–200 chars | — | Human-readable batch name |
| `task_kind` | enum | Yes | One of: `qm_single_point`, `qm_geometry_opt`, `qm_frequencies`, `qm_fukui`, `qm_crest_conformers`, `genchem_scaffold`, `genchem_bioisostere` | — | Type of task in this batch |
| `payloads` | `Record<string, unknown>[]` | Yes | 1–5000 elements | — | Per-task payload objects |
| `priority` | `integer` | No | 0–1000 | `100` | Queue priority (higher = dispatched sooner) |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `batch_id` | `string` | Created batch UUID |
| `task_kind` | `string` | Task kind echoed back |
| `total_requested` | `number` | Number of payloads submitted |
| `inserted` | `number` | Number actually inserted (excluding duplicates) |
| `duplicates` | `number` | Number of payloads that were already present |

**Notes:** Writes an audit row via `appendAudit` with action `queue.enqueue`. Use `inspect_batch` to poll progress.

---

### expand_reaction_context

**Tool ID:** `expand_reaction_context`

**Description:** Expand a reaction with full context: reagents, conditions, outcomes, failures, citations, and optional predecessors. `include` defaults to all except predecessors. Returns `surfaced_fact_ids` for anti-fabrication tracking.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `reaction_id` | `string` (UUID) | Yes | Valid UUID | — | Reaction to expand |
| `include` | `string[]` | No | Elements from: `reagents`, `conditions`, `outcomes`, `failures`, `citations`, `predecessors` | `["reagents", "conditions", "outcomes", "failures", "citations"]` | Context sections to include |
| `hop_limit` | `1 \| 2` | No | Literal 1 or 2 | `1` | Predecessor lookup requires `hop_limit=2` |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `reaction` | object | Core reaction fields: `reaction_id`, `rxn_smiles`, `rxno_class`, `experiment_id`, `project_internal_id`, `yield_pct`, `outcome_status` |
| `reagents` | object[] \| undefined | List of `role`, `smiles`, `equivalents`, `source_eln_entry_id`; present when `"reagents"` in `include` |
| `conditions` | object \| undefined | `temp_c`, `time_min`, `solvent`; present when `"conditions"` in `include` |
| `outcomes` | object[] \| undefined | List of `metric_name`, `value`, `unit`, `source_fact_id`; present when `"outcomes"` in `include` |
| `failures` | object[] \| undefined | List of `failure_mode`, `evidence_text`, `source_fact_id`; present when `"failures"` in `include` |
| `citations` | object[] \| undefined | List of `document_id`, `page`, `excerpt`; present when `"citations"` in `include` (MVP returns empty array) |
| `predecessors` | object[] \| undefined | List of `reaction_id`, `relationship`; present when `"predecessors"` in `include` and `hop_limit=2` |
| `surfaced_fact_ids` | `string[]` (UUIDs) | All KG fact IDs surfaced, for anti-fabrication tracking |

**Notes:** Outcomes and failures are fetched from the KG via `HAS_OUTCOME` and `HAS_FAILURE` predicates respectively; failures are silently empty if the KG query fails. Citations MVP always returns empty.

---

### export_to_ord

**Tool ID:** `export_to_ord`

**Description:** Export a plate (or any list of well dicts with factor values) into an Open Reaction Database (ORD) Dataset protobuf, base64-encoded. The result is a portable format that downstream HTE robotics or LIMS systems can consume.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `plate_name` | `string` | No | 1–200 chars | `"plate"` | Name for the ORD Dataset |
| `reactants_smiles` | `string` | No | 1 – `MAX_RXN_SMILES_LEN` chars | — | Global reactant SMILES (applied to all wells without a per-well `rxn_smiles`) |
| `product_smiles` | `string` | No | 1 – `MAX_SMILES_LEN` chars | — | Global product SMILES |
| `wells` | object[] | Yes | 1–2000 elements | — | Well descriptors |
| `wells[].well_id` | `string` | Yes | — | — | Well identifier (e.g. `A01`) |
| `wells[].rxn_smiles` | `string \| null` | No | — | — | Per-well reaction SMILES (overrides global) |
| `wells[].factor_values` | `Record<string, unknown>` | Yes | — | — | Experimental conditions for this well |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `ord_protobuf_b64` | `string` | Base64-encoded ORD Dataset protobuf |
| `n_reactions` | `integer` | Number of Reaction messages in the Dataset |
| `summary` | `Record<string, unknown>` | Dataset-level metadata |

---

### extract_chrom_pareto_front

**Tool ID:** `extract_chrom_pareto_front`

**Description:** Return the non-dominated (Pareto-optimal) HPLC methods for a multi-objective chromatography optimization campaign — the trade-off frontier over min-resolution (maximize) × runtime (minimize) × solvent footprint (minimize). Reads all measured outcomes from the campaign's rounds (RLS-scoped). Use after a few rounds to let the chemist pick the method that balances resolution, speed, and green-ness.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `campaign_id` | `string` (UUID) | Yes | Valid UUID | — | Chromatography optimization campaign |
| `output_directions` | `Record<string, "maximize" \| "minimize">` | No | — | — | Override default objective directions if the campaign used a non-standard output set |

Default directions: `min_resolution → maximize`, `runtime_min → minimize`, `solvent_pmi_g → minimize`.

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `campaign_id` | `string` (UUID) | Echoed campaign ID |
| `pareto` | object[] | Non-dominated methods; each has `factor_values` and `outputs` |
| `n_total` | `integer` | Total measured outcomes evaluated |
| `n_pareto` | `integer` | Number of Pareto-optimal methods |
| `output_directions` | `Record<string, string>` | Directions actually used |

**Notes:** Returns an empty `pareto` with `n_total=0` and `n_pareto=0` when no measured outcomes exist. Throws `campaign_not_found` if the campaign is not visible to the caller.

---

### extract_pareto_front

**Tool ID:** `extract_pareto_front`

**Description:** Compute the Pareto frontier (non-dominated set) of a campaign's measured outcomes. Each output is treated per its declared direction (maximize/minimize). Useful for surfacing the trade-off frontier in multi-objective campaigns (yield × selectivity × PMI × greenness × safety).

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `campaign_id` | `string` (UUID) | Yes | Valid UUID | — | Optimization campaign |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `campaign_id` | `string` (UUID) | Echoed campaign ID |
| `pareto` | object[] | Non-dominated outcomes; each has `factor_values` and `outputs` |
| `n_total` | `integer` | Total measured outcomes evaluated |
| `n_pareto` | `integer` | Number of Pareto-optimal outcomes |
| `output_directions` | `Record<string, string>` | Directions derived from `bofire_domain` |

**Notes:** Objective directions are derived from the campaign's `bofire_domain.outputs.features[].objective.type`. Only `MaximizeObjective` and `MinimizeObjective` are supported; any other type (e.g. `CloseToTargetObjective`) causes an error. Returns empty pareto if no measured outcomes exist.

---

### fetch_eln_canonical_reaction

**Tool ID:** `fetch_eln_canonical_reaction`

**Description:** Fetch one canonical reaction from the local mock ELN plus its top-N OFAT child entries (sorted by yield descending). Use after `query_eln_canonical_reactions` to inspect the conditions explored.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `reaction_id` | `string` | Yes | 1–128 chars, must match `[A-Za-z0-9_.:-]+` | — | ELN reaction identifier |
| `top_n_ofat` | `integer` | No | 0–200 | `10` | Number of OFAT child entries to return |

**Output Fields** (CanonicalReactionDetail)

| Field | Type | Description |
|---|---|---|
| `reaction_id` | `string` | ELN reaction ID |
| `canonical_smiles_rxn` | `string` | Canonical reaction SMILES |
| `family` | `string` | Reaction family classification |
| `project_id` | `string` | ELN project identifier |
| `project_code` | `string \| null` | Short project code |
| `step_number` | `integer \| null` | Step number in the synthesis sequence |
| `ofat_count` | `integer` | Total number of OFAT entries |
| `mean_yield` | `number \| null` | Mean yield across all OFAT entries |
| `last_activity_at` | `string \| null` | ISO timestamp of last activity |
| `citation_uri` | `string` | Citation URI |
| `valid_until` | `string` | Cache validity timestamp |
| `ofat_children` | `ElnEntry[]` | Top-N child ELN entries (sorted by yield, desc) |

---

### fetch_eln_entry

**Tool ID:** `fetch_eln_entry`

**Description:** Fetch a single ELN entry by ID from the local mock ELN. Returns the full `fields_jsonb`, freetext, attachments metadata, and audit summary. Use after `query_eln_experiments` to drill into a specific run.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `entry_id` | `string` | Yes | 1–128 chars, must match `[A-Za-z0-9_.:-]+` | — | ELN entry identifier |

**Output Fields** (ElnEntry)

| Field | Type | Description |
|---|---|---|
| `id` | `string` | ELN entry ID |
| `notebook_id` | `string` | Notebook identifier |
| `project_id` | `string` | ELN project ID |
| `project_code` | `string \| null` | Short project code |
| `reaction_id` | `string \| null` | Linked canonical reaction ID |
| `schema_kind` | `string` | Entry schema type |
| `title` | `string` | Entry title |
| `author_email` | `string \| null` | Author email |
| `signed_by` | `string \| null` | Signer email |
| `status` | `string` | Entry status |
| `entry_shape` | `string` | Entry format shape |
| `data_quality_tier` | `string` | Data quality classification |
| `fields_jsonb` | `Record<string, unknown>` | Structured experiment fields |
| `freetext` | `string \| null` | Free-text notes |
| `freetext_length_chars` | `integer` | Freetext character count |
| `created_at` | `string` | ISO creation timestamp |
| `modified_at` | `string` | ISO last-modified timestamp |
| `signed_at` | `string \| null` | ISO signing timestamp |
| `citation_uri` | `string` | Citation URI |
| `valid_until` | `string` | Cache validity timestamp |
| `attachments` | object[] | Attachment metadata list |
| `audit_summary` | object[] | Audit trail entries |

**Notes:** The `source-cache` post_tool hook fires automatically on this tool (name matches `^(query|fetch)_(eln|lims|instrument)_`).

---

### fetch_eln_sample

**Tool ID:** `fetch_eln_sample`

**Description:** Fetch one ELN sample (isolated material) with all linked analytical results from the local mock ELN. Use after `fetch_eln_entry` to bridge from an experiment into downstream analytical data.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `sample_id` | `string` | Yes | 1–128 chars, must match `[A-Za-z0-9_.:-]+` | — | ELN sample identifier |

**Output Fields** (Sample)

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Sample ID |
| `entry_id` | `string` | Parent ELN entry ID |
| `sample_code` | `string` | Lab sample code |
| `compound_id` | `string \| null` | Linked compound identifier |
| `amount_mg` | `number \| null` | Mass isolated in milligrams |
| `purity_pct` | `number \| null` | Purity percentage |
| `notes` | `string \| null` | Free-text notes |
| `created_at` | `string` | ISO creation timestamp |
| `citation_uri` | `string` | Citation URI |
| `valid_until` | `string` | Cache validity timestamp |
| `results` | object[] | Linked analytical results (id, method_id, metric, value_num, value_text, unit, measured_at, metadata) |

---

### fetch_full_document

**Tool ID:** `fetch_full_document`

**Description:** Retrieve the full parsed markdown of a document by UUID. Use after `search_knowledge` to read the complete document rather than isolated chunks. Alias for `fetch_original_document(format='markdown')` — prefer that tool for bytes/pdf_pages access. Truncated at 200,000 characters.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `document_id` | `string` (UUID) | Yes | Valid UUID | — | Document UUID from the `documents` table |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `document_id` | `string` (UUID) | Echoed document ID |
| `sha256` | `string \| null` | SHA-256 hash of the original file |
| `title` | `string \| null` | Document title |
| `source_type` | `string \| null` | Source type (e.g. `sop`, `patent`, `paper`) |
| `version` | `string \| null` | Document version |
| `effective_date` | `string \| null` | ISO effective date |
| `parsed_markdown` | `string \| null` | Full parsed markdown (truncated to 200,000 chars with a truncation notice) |
| `chunk_count` | `integer` | Number of chunks in `document_chunks` |

---

### fetch_instrument_run

**Tool ID:** `fetch_instrument_run`

**Description:** Fetch a single LOGS-by-SciY analytical dataset by UID. Returns the canonical dataset record including parameters and detector tracks.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `uid` | `string` | Yes | 1–128 chars, must match `^[A-Za-z0-9_.-]+$` | — | LOGS dataset UID |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `dataset` | `LogsDataset` | Full dataset record (see below) |
| `valid_until` | `string` | Cache validity timestamp |

**LogsDataset shape:** `backend` (`"fake-postgres" \| "real"`), `uid`, `name`, `instrument_kind` (HPLC/NMR/MS/GC-MS/LC-MS/IR), `instrument_serial`, `method_name`, `sample_id`, `sample_name`, `operator`, `measured_at` (ISO), `parameters` (record), `tracks[]` (each with `track_index`, `detector`, `unit`, `peaks[]`), `project_code`, `citation_uri`.

**Notes:** Tool name matches `^fetch_instrument_/` so the `source-cache` post_tool hook fires automatically.

---

### fetch_lims_result

**Tool ID:** `fetch_lims_result`

> **Status: pending registration.** This tool file exists but is not yet wired into `dependencies.ts` and will not appear in the agent's live tool list. It is documented here for completeness; it becomes active once registered.

**Description:** Fetch a single LIMS test result from STARLIMS by result ID. Returns full analytical result detail including method, value, unit, and analyst. Use after `query_lims_results` to retrieve a specific result.

**Annotations:** none specified (Phase F.2 builtin)

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `result_id` | `string` | Yes | 1–200 chars | — | STARLIMS result ID |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Result ID |
| `sample_id` | `string \| null` | Associated sample ID |
| `method_id` | `string \| null` | Analytical method ID |
| `analysis_name` | `string \| null` | Analysis name |
| `result_value` | `string \| null` | Result value (string representation) |
| `result_unit` | `string \| null` | Result unit |
| `status` | `string \| null` | Result status |
| `analyst` | `string \| null` | Analyst identifier |
| `completed_at` | `string \| null` | ISO completion timestamp |
| `citation` | `Citation` | Auto-generated citation with `source_kind="external_url"` pointing to the STARLIMS URL |
| `source_system` | `"starlims"` (literal) | Always `"starlims"` |

**Notes:** Timeout: 20,000 ms. Issues a GET request to `{mcpLimsStarlimsUrl}/test_results/{result_id}`.

---

### fetch_original_document

**Tool ID:** `fetch_original_document`

**Description:** Retrieve a document by ID in one of three formats. `format='markdown'` (default) returns parsed Markdown from Postgres — use for text-only questions. `format='bytes'` returns the raw original file (PDF/DOCX/PPTX/…) as base64 — use for figures, tables, or layout questions. `format='pdf_pages'` renders specific PDF pages to base64 PNG images — use when you need to see a figure or table on a specific page.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `document_id` | `string` (UUID) | Yes | Valid UUID | — | Document UUID from the `documents` table |
| `format` | `"bytes" \| "markdown" \| "pdf_pages"` | No | — | `"markdown"` | Output format |
| `pages` | `integer[]` | No | max 50 elements, each ≥ 0 | — | Zero-indexed page numbers; required for `pdf_pages`, ignored otherwise |

**Output Fields** (discriminated union on `format`)

**When `format="markdown"`:**

| Field | Type | Description |
|---|---|---|
| `format` | `"markdown"` | Literal discriminant |
| `document_id` | `string` (UUID) | Echoed document ID |
| `title` | `string \| null` | Document title |
| `markdown` | `string \| null` | Parsed markdown content |

**When `format="bytes"`:**

| Field | Type | Description |
|---|---|---|
| `format` | `"bytes"` | Literal discriminant |
| `document_id` | `string` (UUID) | Echoed document ID |
| `content_type` | `string` | MIME type of the original file |
| `base64_bytes` | `string` | Base64-encoded file content (max 25 MB) |
| `byte_count` | `number` | File size in bytes |
| `citation` | `Citation` | Source citation with `source_kind="original_doc"` |

**When `format="pdf_pages"`:**

| Field | Type | Description |
|---|---|---|
| `format` | `"pdf_pages"` | Literal discriminant |
| `document_id` | `string` (UUID) | Echoed document ID |
| `pages` | object[] | Rendered page images: `page` (int), `base64_png` (string), `width` (number), `height` (number) |
| `citation` | `Citation` | Source citation with `page` set to the first requested page |

**Notes:** The markdown path reads directly from Postgres (fast, ~5 s timeout). The bytes and pdf_pages paths require `original_uri` to be populated in the `documents` table and call mcp-doc-fetcher (60 s timeout). Default pages for `pdf_pages` is `[0]` (first page).

---

### find_matched_pairs

**Tool ID:** `find_matched_pairs`

**Description:** Look up matched-molecular-pairs (MMPs) for a SMILES from the corpus. Returns pairs of `(lhs, rhs)` compounds plus the `transformation_smarts` that links them, plus any recorded delta properties (e.g. `delta_logP`). Useful for SAR-transfer hypotheses.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `smiles` | `string` | Yes | 1–10,000 chars | — | Query molecule SMILES |
| `n` | `integer` | No | 1–200 | `20` | Maximum number of matched pairs to return |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `pairs` | object[] | Matched pairs |
| `pairs[].lhs_inchikey` | `string` | Left-hand-side compound InChIKey |
| `pairs[].rhs_inchikey` | `string` | Right-hand-side compound InChIKey |
| `pairs[].transformation_smarts` | `string` | SMARTS pattern for the structural transformation |
| `pairs[].delta_property` | `Record<string, unknown>` | Recorded property deltas (e.g. `delta_logP`, `delta_pIC50`) |

---

### find_similar_compounds

**Tool ID:** `find_similar_compounds`

**Description:** Find the K nearest compounds to a query SMILES by chemical similarity. Uses fingerprint-vector cosine search over the compounds corpus (`morgan_r2` is the typical default for drug-like similarity; pick `maccs` for functional-group similarity). Returns InChIKey, canonical SMILES, and similarity score.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `smiles` | `string` | Yes | 1–10,000 chars | — | Query molecule SMILES |
| `fingerprint` | `"morgan_r2" \| "morgan_r3" \| "maccs" \| "atompair"` | No | — | `"morgan_r2"` | Fingerprint family for similarity search |
| `k` | `integer` | No | 1–100 | `20` | Number of nearest neighbors to return |
| `min_similarity` | `number` | No | 0–1 | `0.0` | Minimum cosine similarity threshold |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `fingerprint` | `string` | Fingerprint family used |
| `hits` | object[] | Nearest neighbor results |
| `hits[].inchikey` | `string` | Compound InChIKey |
| `hits[].smiles_canonical` | `string \| null` | Canonical SMILES |
| `hits[].similarity` | `number` | Cosine similarity score (0–1) |

**Notes:** The fingerprint column name is validated against a hardcoded allowlist before SQL interpolation to prevent injection. Fingerprint encoding is performed via mcp-rdkit; the pgvector cosine search runs via `withSystemContext` (not RLS-scoped, reads all compounds).

---

### find_similar_reactions

**Tool ID:** `find_similar_reactions`

**Description:** Find reactions similar to a seed reaction SMILES using DRFP fingerprint cosine search. Returns up to k reactions with their experiment context and citations.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `rxn_smiles` | `string` | Yes | 3–20,000 chars | — | Seed reaction SMILES (reactants>>products format) |
| `k` | `integer` | No | 1–50 | `10` | Number of similar reactions to return |
| `rxno_class` | `string` | No | max 200 chars | — | Filter to this RXNO reaction class |
| `min_yield_pct` | `number` | No | 0–100 | — | Minimum yield percentage filter |
| `solvent` | `string` | No | max 100 chars | — | Exact solvent name filter |
| `base` | `string` | No | max 100 chars | — | Exact base name filter |
| `min_temperature_c` | `number` | No | -100–500 | — | Minimum reaction temperature in °C |
| `max_temperature_c` | `number` | No | -100–500 | — | Maximum reaction temperature in °C |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `seed_canonicalized` | object | `rxn_smiles` (string), `on_bit_count` (integer) |
| `results` | `SimilarReaction[]` | Ordered by DRFP cosine distance (ascending) |
| `results[].reaction_id` | `string` (UUID) | Reaction ID |
| `results[].rxn_smiles` | `string \| null` | Reaction SMILES |
| `results[].rxno_class` | `string \| null` | RXNO class |
| `results[].distance` | `number` | Cosine distance (lower = more similar) |
| `results[].experiment_id` | `string` (UUID) | Parent experiment |
| `results[].eln_entry_id` | `string \| null` | Linked ELN entry |
| `results[].project_internal_id` | `string` | Project identifier |
| `results[].yield_pct` | `number \| null` | Reaction yield |
| `results[].outcome_status` | `string \| null` | Experiment outcome |
| `results[].citation` | `Citation` | Citation with `source_kind="reaction"` |

**Notes:** DRFP encoding is performed via mcp-drfp with `n_folded_length=2048, radius=3`. The pgvector cosine search is RLS-scoped via `withUserContext` and queries only `reactions_current` (non-invalidated, non-superseded rows).

---

### forge_tool

**Tool ID:** `forge_tool`

**Description:** Forge a new reusable Python tool using the 4-stage Forjador algorithm (analyze → generate → execute → evaluate). Provide a name (slug), description, JSON Schema for inputs and outputs, at least 2 test cases, and an optional implementation hint. On all-pass the tool is persisted in the `skill_library` (shadow period: 14 days). On any-fail the failures are returned for re-iteration. Do NOT use this tool to forge `forge_tool` or `run_program` themselves.

**Annotations:** `readOnly: false`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `name` | `string` | Yes | 1–64 chars, must match `^[a-z][a-z0-9_]*$` | — | Tool name (lowercase slug) |
| `description` | `string` | Yes | 1–2000 chars | — | What the tool does |
| `input_schema_json` | `Record<string, unknown>` | Yes | Must be a JSON Schema object with `type: "object"` | — | JSON Schema for the tool's input |
| `output_schema_json` | `Record<string, unknown>` | Yes | Must be a JSON Schema object with `type: "object"` | — | JSON Schema for the tool's output |
| `test_cases` | object[] | Yes | 2–10 elements | — | Test cases to validate the generated code |
| `test_cases[].input` | `Record<string, unknown>` | Yes | — | — | Test input |
| `test_cases[].expected_output` | `Record<string, unknown>` | Yes | — | — | Expected output |
| `test_cases[].tolerance` | `number` | No | 0–1 | — | Numeric tolerance for floating-point comparisons |
| `implementation_hint` | `string` | No | max 2000 chars | — | Optional hint to guide code generation |
| `parent_tool_id` | `string` (UUID) | No | Valid UUID of an existing `skill_library` `forged_tool` row | — | Fork from an existing forged tool (increments version) |
| `nce_project_id` | `string` (UUID) | No | Valid UUID | — | NCE project context; when set, stamps the project on the new skill as the first validating project for the cross-project promoter |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `tool_id` | `string` (UUID) | UUID of the new tool entry |
| `validation.passed` | `integer` | Number of test cases that passed |
| `validation.failed` | `integer` | Number of test cases that failed |
| `validation.failures` | object[] | Per-failure details: `test_index`, `error`, `observed_output` |
| `persisted` | `boolean` | Whether the tool was written to disk and DB (only true when all tests pass) |
| `skill_library_row_id` | `string` (UUID) | UUID of the inserted `skill_library` row (present when `persisted=true`) |
| `version` | `integer` | Version number (1 for new tools, `parent.version + 1` for forks) |

**Notes:** The 4 stages are: (1) Analyze — validate schemas, check name conflicts, reject protected names; (2) Generate — LLM writes Python via LiteLLM; (3) Execute — run each test in an isolated E2B sandbox; (4) Evaluate — compare actual vs expected with optional tolerance. Persistence is all-or-nothing across `skill_library`, `tools`, and `forged_tool_tests` tables. After successful persistence, the tool is hot-registered into the live `ToolRegistry` so it is callable in the same chained turn. Protected names: `forge_tool`, `run_program`.

---

### generate_focused_library

**Tool ID:** `generate_focused_library`

**Description:** Propose a chemically reasonable library around a seed SMILES. `kind='scaffold'` or `'rgroup'` enumerate over `[*:N]` attachment points; `'bioisostere'` applies curated bioisostere rewrites; `'grow'` uses RDKit BRICS to extend a fragment; `'link'` connects two fragments via short linkers. Returns `gen_runs.run_id` and ranked proposals (canonical SMILES + InChIKey).

**Annotations:** `readOnly: true`, `result_schema_id: "gen_run.v1"`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `kind` | `"scaffold" \| "rgroup" \| "bioisostere" \| "grow" \| "link"` | No | — | `"scaffold"` | Generator type |
| `seed_smiles` | `string` | Yes | 1–10,000 chars | — | Seed molecule SMILES. For `scaffold`/`rgroup`: use `[*:N]` attachment points. For `bioisostere`/`grow`: complete molecule. Not used for `link` |
| `fragment_a` | `string` | Conditional | 1–10,000 chars; required when `kind="link"` | — | First fragment for linker-based library |
| `fragment_b` | `string` | Conditional | 1–10,000 chars; required when `kind="link"` | — | Second fragment for linker-based library |
| `rgroups` | `Record<string, string[]>` | No | — | — | Custom R-group lists keyed by attachment-point index; used for `scaffold` and `rgroup` kinds |
| `max_proposals` | `integer` | No | 1–500 | `50` | Maximum number of proposals to return |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `run_id` | `string \| null` | Generation run ID from `gen_runs` table |
| `kind` | `string` | Generator kind echoed back |
| `n_proposed` | `number` | Total number of proposals |
| `proposals` | object[] | Proposed structures |
| `proposals[].smiles` | `string` | Canonical SMILES |
| `proposals[].inchikey` | `string \| null` | InChIKey |
| `proposals[].parent_inchikey` | `string \| null` | InChIKey of the parent/seed |
| `proposals[].transformation` | `Record<string, unknown>` | Transformation metadata |
| `proposals[].scores` | `Record<string, number>` | Scoring metrics |

**Notes:** Timeout: 120,000 ms. Each `kind` maps to a different mcp-genchem endpoint: `scaffold` → `/scaffold_decorate`, `rgroup` → `/rgroup_enumerate`, `bioisostere` → `/bioisostere_replace`, `grow` → `/fragment_grow`, `link` → `/fragment_link`.

---

### get_synthesis_campaign

**Tool ID:** `get_synthesis_campaign`

**Description:** Fetch one synthesis campaign by ID, including its full step DAG and recent events. Use to resume a campaign on a new session or to inspect step status before deciding the next action.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `campaign_id` | `string` (UUID) | Yes | Valid UUID | — | Campaign to fetch |
| `include_events` | `boolean` | No | — | `true` | Whether to include the event log |
| `events_limit` | `integer` | No | 1–200 | `50` | Maximum number of recent events to return (ordered newest first) |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `campaign` | `CampaignSummary` | Campaign metadata and status |
| `steps` | `StepSummary[]` | All steps ordered by `step_index` ascending |
| `events` | object[] | Recent events (newest first): `id`, `step_id` (nullable UUID), `event_type`, `payload`, `occurred_at` |

**CampaignSummary fields:** `id`, `nce_project_id`, `agent_session_id` (nullable UUID), `kind` (CampaignKind), `name`, `status` (CampaignStatus), `goal` (JsonRecord), `policy` (JsonRecord), `total_steps`, `completed_steps`, `outcome_summary` (nullable), `created_at`, `updated_at`, `etag`.

---

### identify_unknown_from_ms

**Tool ID:** `identify_unknown_from_ms`

**Description:** Identify an unknown compound from an MS2 spectrum using SIRIUS 6 + CSI:FingerID + CANOPUS. Returns ranked structural candidates with ClassyFire classification. Use for unknown impurity identification from analytical data. Latency approximately 60–120 seconds.

**Annotations:** `readOnly: true`, `result_schema_id: "identify.v1"`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `ms2_peaks` | object[] | Yes | 1–5000 elements | — | MS2 peak list |
| `ms2_peaks[].m_z` | `number` | Yes | positive | — | m/z value |
| `ms2_peaks[].intensity` | `number` | Yes | positive | — | Peak intensity |
| `precursor_mz` | `number` | Yes | positive, max 10,000 | — | Precursor m/z (monoisotopic) |
| `ionization` | `"positive" \| "negative"` | No | — | `"positive"` | Electrospray ionization mode |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `candidates` | object[] | Ranked structural candidates |
| `candidates[].smiles` | `string` | Candidate SMILES |
| `candidates[].name` | `string` | Compound name |
| `candidates[].score` | `number` | CSI:FingerID score |
| `candidates[].classyfire.kingdom` | `string` | ClassyFire kingdom classification |
| `candidates[].classyfire.superclass` | `string` | ClassyFire superclass |
| `candidates[].classyfire.class` | `string` | ClassyFire class |
| `citation` | `Citation` | Auto-generated citation with `source_kind="external_url"` (present when candidates exist) |

**Notes:** Timeout: 150,000 ms. The citation `source_id` is `sirius:{precursor_mz:.4f}`.

---

### inchikey_from_smiles

**Tool ID:** `inchikey_from_smiles`

**Description:** Compute the InChIKey for a SMILES string via RDKit. Use when you need a stable canonical compound identifier without canonical SMILES, formula, or MW. Library-design and QM pipeline planner skills declare this as a required tool.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `smiles` | `string` | Yes | 1–10,000 chars | — | Input SMILES string |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `inchikey` | `string` | Standard InChIKey (27-character hash) |

**Notes:** Distinct from `canonicalize_smiles` (which also returns formula/MW/canonical SMILES). Delegates to mcp-rdkit `/tools/inchikey_from_smiles`. Timeout: 10,000 ms.

---

### induce_forged_tool_from_trace

**Tool ID:** `induce_forged_tool_from_trace`

**Description:** Read a Langfuse trace, extract the tool-call sequence, and ask the planner to generalize it into a reusable Python tool. Runs the full 4-stage Forjador validation pipeline. Provide the `trace_id`, a unique tool name (slug), and a description.

**Annotations:** `readOnly: false`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `trace_id` | `string` | Yes | 1–200 chars | — | Langfuse trace ID to read |
| `name` | `string` | Yes | 1–64 chars, must match `^[a-z][a-z0-9_]*$` | — | Tool name for the induced tool (lowercase slug) |
| `description` | `string` | Yes | 1–2000 chars | — | Description of what the induced tool does |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `trace_id` | `string` | Echoed trace ID |
| `tool_events_found` | `integer` | Number of tool-call SPAN events found in the trace |
| `forge_result` | `unknown` | Full result from the delegated `forge_tool` call |

**Notes:** Production requires `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_HOST` environment variables. The planner LLM role is used for generalization. Test harnesses provide a mock `traceReader`. Throws if no tool-call events are found in the trace. Delegates to `forge_tool` with `forgedByRole="planner"` — the full Forjador 4-stage pipeline runs.

---

### ingest_campaign_results

**Tool ID:** `ingest_campaign_results`

**Description:** Record measured outcomes for a previously-proposed optimization round. Validates factor and output keys against the campaign's BoFire Domain and rejects out-of-bounds values. When the round belongs to a `synthesis_campaigns` umbrella, the matching `bo_round` step is automatically backfilled with `experiments_added + improved` so the `bo_or_die` die-gate sees real signals.

**Annotations:** `readOnly: false`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `round_id` | `string` (UUID) | Yes | Valid UUID | — | UUID of the optimization round to record outcomes for |
| `measured_outcomes` | object[] | Yes | 1–2000 elements | — | Measured outcomes for this round |
| `measured_outcomes[].factor_values` | `Record<string, unknown>` | Yes | Keys must match the campaign's `bofire_domain.inputs` | — | Factor conditions for this measurement |
| `measured_outcomes[].outputs` | `Record<string, number>` | Yes | Keys must match `bofire_domain.outputs`; values must be finite and within `output_bounds` | — | Measured output values |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `round_id` | `string` (UUID) | Echoed round ID |
| `campaign_id` | `string` (UUID) | Parent campaign ID |
| `n_outcomes` | `integer` | Number of outcomes recorded |
| `ingested_at` | `string` | ISO timestamp of ingestion |
| `improved` | `boolean` | Whether any new outcome improves on all prior rounds (direction-aware) |
| `step_backfilled` | `boolean` | Whether a synthesis campaign `bo_round` step was backfilled |

**Notes:** Idempotency-guarded by `ingested_results_at IS NULL` — throws `round_already_ingested` on duplicate calls. Bumps the campaign's `etag`. Multi-objective improvement is detected via Pareto dominance (any new non-dominated point counts as improvement).

---

### ingest_chrom_results

**Tool ID:** `ingest_chrom_results`

**Description:** Score measured chromatograms for a chromatography optimization round and record them as the round's measured outcomes. For each proposal run, pass the `proposal_index`, detected peak list, and optional method context and target compounds. Computes the Niezen-Desmet CRF and the min-resolution / runtime / solvent-PMI objectives via the MCP, then writes `optimization_rounds.measured_outcomes` (RLS-scoped).

**Annotations:** `readOnly: false`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `round_id` | `string` (UUID) | Yes | Valid UUID | — | UUID of the chromatography optimization round |
| `runs` | object[] | Yes | 1–200 elements | — | Per-proposal measured chromatograms |
| `runs[].proposal_index` | `integer` | Yes | 0–199 | — | Index into the round's proposals array |
| `runs[].peaks` | object[] | Yes | max 2000 elements | — | Detected peak records (flexible schema) |
| `runs[].targets` | object[] | No | max 200 elements | `[]` | Target compounds for peak matching |
| `runs[].targets[].name` | `string` | Yes | 1–200 chars | — | Target compound name |
| `runs[].targets[].m_z` | `number \| null` | No | — | — | Target m/z for MS-based matching |
| `runs[].targets[].spectrum` | `number[]` | No | max 1024 elements | — | DAD-UV reference spectrum for cosine similarity matching |
| `runs[].runtime_min` | `number` | No | positive | — | Total run time in minutes |
| `runs[].b_solvent` | `string` | No | max 50 chars | — | B-phase solvent name |
| `runs[].b_meoh_fraction` | `number` | No | 0–1 | — | Fraction of methanol in B phase (for PMI calculation) |
| `runs[].flow_mLmin` | `number` | No | positive | — | Flow rate in mL/min |
| `runs[].avg_pctB` | `number` | No | 0–100 | — | Average %B over the gradient |
| `rs_target` | `number` | No | positive | `1.5` | Target resolution (Rs) for the CRF calculation |
| `runtime_target_min` | `number` | No | positive | `8.0` | Target runtime in minutes for the CRF calculation |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `round_id` | `string` (UUID) | Echoed round ID |
| `campaign_id` | `string` (UUID) | Parent campaign ID |
| `n_outcomes` | `integer` | Number of scored chromatograms recorded |
| `ingested_at` | `string` | ISO timestamp of ingestion |
| `scored` | object[] | Per-proposal scores |
| `scored[].proposal_index` | `integer` | Proposal index |
| `scored[].crf_total` | `number` | Niezen-Desmet CRF total score |
| `scored[].min_resolution` | `number` | Minimum resolution between adjacent peaks |
| `scored[].runtime_min` | `number` | Run time in minutes |
| `scored[].solvent_pmi_g` | `number` | Solvent process mass intensity in grams |
| `scored[].tracking_confidence` | `string` | Confidence in peak tracking (`high`/`medium`/`low`) |

**Notes:** When method context is omitted from a run, values are automatically pulled from the corresponding proposal's `factor_values`. Idempotency-guarded; throws `round_already_ingested` if already ingested.

---

### inspect_batch

**Tool ID:** `inspect_batch`

**Description:** Get progress of a queued batch — counts of pending/succeeded/failed/cancelled tasks plus a sample of recent results. Pass `batch_id` from `enqueue_batch`.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `batch_id` | `string` (UUID) | Yes | Valid UUID | — | Batch ID from `enqueue_batch` |
| `sample_n` | `integer` | No | 0–50 | `5` | Number of recent result samples to return |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `batch_id` | `string` | Batch UUID |
| `name` | `string \| null` | Batch name |
| `kind` | `string \| null` | Task kind |
| `total` | `number` | Total tasks in the batch |
| `succeeded` | `number` | Completed successfully |
| `failed` | `number` | Failed |
| `cancelled` | `number` | Cancelled |
| `pending` | `number` | Not yet in a terminal state (computed as `total - succeeded - failed - cancelled`) |
| `created_at` | `string` | ISO creation timestamp |
| `finished_at` | `string \| null` | ISO completion timestamp (null if not all terminal) |
| `sample_results` | object[] | Sample task results: `task_kind`, `status`, `result` |

---

### kick_workflow_and_wait

**Tool ID:** `kick_workflow_and_wait`

**Description:** Start a workflow run AND poll until it reaches a terminal status (succeeded / failed / cancelled / timed_out). Use this for synchronous workflows where you want the output before deciding the next step. For long-running runs you intend to background, use `workflow_run` + `workflow_inspect` instead.

**Annotations:** `readOnly: false`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `workflow_id` | `string` (UUID) | Yes | Valid UUID | — | Workflow definition to run |
| `input` | `Record<string, unknown>` | No | — | `{}` | Input payload for the workflow |
| `session_id` | `string` (UUID) | No | Valid UUID | — | Agent session to associate with the run |
| `timeout_seconds` | `integer` | No | 1–3600 | `300` | Hard ceiling on the polling wait |
| `poll_interval_seconds` | `integer` | No | 1–30 | `2` | Polling interval in seconds |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `run_id` | `string` | Created workflow run ID |
| `status` | `"succeeded" \| "failed" \| "cancelled" \| "timed_out"` | Terminal status |
| `output` | `Record<string, unknown> \| null` | Workflow output (null on failure/timeout) |
| `finished_at` | `string \| null` | ISO finish timestamp |
| `events_seen` | `integer` | Number of workflow events observed |
| `duration_ms` | `integer` | Wall-clock duration in milliseconds |
| `last_failure` | object \| null | When `status="failed"` or `"timed_out"`: `step_id` (string \| null) and `error` (string) from the last `step_failed` event |

**Notes:** Respects the parent harness's `AbortSignal` — a client disconnect cancels the polling loop. The workflow run continues asynchronously even on timeout; the agent can call `workflow_inspect` later to follow up.

---

### list_articles

**Tool ID:** `list_articles`

**Description:** List knowledge-wiki pages visible to the caller, filtered by kind, project, free-text, maturity floor, or dirty (stale) status. Use to discover whether a page already exists before reading or requesting one.

**Annotations:** `readOnly: true`

**Feature Gate:** Requires the `wiki.enabled` feature flag to be on (default OFF). Throws a clear error with admin instructions otherwise.

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `kind` | `ArticleKind[]` | No | Subset of: `compound`, `reaction_family`, `nce_project`, `synthesis_campaign`, `document_digest`, `researcher`, `topic`, `glossary`, `index`, `log`, `contradiction` | — | Filter to specific article kinds |
| `nce_project_internal_id` | `string` | No | 1–200 chars | — | Filter to articles belonging to this NCE project |
| `query` | `string` | No | 1–200 chars | — | ILIKE text search against slug, title, and summary |
| `dirty_only` | `boolean` | No | — | `false` | Only return pages with stale backing data |
| `maturity_min` | `"EXPLORATORY" \| "WORKING" \| "FOUNDATION"` | No | — | — | Minimum maturity level (EXPLORATORY < WORKING < FOUNDATION) |
| `include_archived` | `boolean` | No | — | `false` | Include archived pages in results |
| `limit` | `integer` | No | 1–200 | `50` | Maximum number of results |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `articles` | `ArticleSummary[]` | List of article summaries |

**ArticleSummary shape:** `id` (UUID), `slug` (string), `kind` (ArticleKind), `title` (string), `summary` (string \| null), `maturity` (Maturity), `confidence_score` (number \| null), `status` (`"current" \| "archived"`), `dirty` (boolean), `has_human_edits` (boolean), `source_count` (integer), `revision` (integer), `updated_at` (ISO string).

---

### list_directory

**Tool ID:** `list_directory`

**Description:** List entries of a directory under `AGENT_FS_ROOT`. Returns name and kind (file/directory/symlink/other), and size for files. Capped at `limit` entries (default 1000); `truncated=true` when the cap was hit.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `path` | `string` | Yes | 1–4096 chars | — | Relative path under `AGENT_FS_ROOT` |
| `limit` | `integer` | No | 1–5000 | `1000` | Maximum number of directory entries to return |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `path` | `string` | Echoed input path |
| `entries` | object[] | Directory entries |
| `entries[].name` | `string` | File or directory name |
| `entries[].kind` | `"file" \| "directory" \| "symlink" \| "other"` | Entry type |
| `entries[].size_bytes` | `number` | File size in bytes (files only; may be absent if unreadable) |
| `truncated` | `boolean` | Whether the entry count exceeded `limit` |
| `total` | `number` | Total number of entries in the directory (including those not returned) |

---

### list_synthesis_campaigns

**Tool ID:** `list_synthesis_campaigns`

**Description:** List synthesis campaigns visible to the caller, optionally filtered by status, kind, project, or owner. Use to find a resumable campaign for a user before starting a new one.

**Annotations:** `readOnly: true`

**Input Parameters**

| Parameter | Type | Required | Constraints | Default | Description |
|---|---|---|---|---|---|
| `status` | `CampaignStatus[]` | No | Subset of: `proposed`, `active`, `awaiting_measurement`, `paused`, `completed`, `aborted`, `failed`, `died` | — | Filter to these statuses |
| `kind` | `CampaignKind[]` | No | Subset of: `single_experiment`, `library_synthesis`, `screening`, `bo_campaign`, `bo_or_die` | — | Filter to these campaign kinds |
| `nce_project_internal_id` | `string` | No | 1–200 chars | — | Filter to campaigns belonging to this NCE project |
| `only_mine` | `boolean` | No | — | `false` | If true, return only campaigns created by the calling user |
| `limit` | `integer` | No | 1–100 | `25` | Maximum number of results |

**Output Fields**

| Field | Type | Description |
|---|---|---|
| `campaigns` | `CampaignSummary[]` | List of campaign summaries (ordered by `updated_at` DESC) |

**CampaignSummary fields:** same as in `get_synthesis_campaign` — `id`, `nce_project_id`, `agent_session_id`, `kind`, `name`, `status`, `goal`, `policy`, `total_steps`, `completed_steps`, `outcome_summary`, `created_at`, `updated_at`, `etag`.