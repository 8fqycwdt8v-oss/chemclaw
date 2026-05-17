# ChemClaw Builtin Tools Reference — M through Z

This document covers all builtin agent tools with names beginning M–Z (excluding QM tools which are in [builtin-tools-qm.md](builtin-tools-qm.md)). For tools A–L see [builtin-tools-a-l.md](builtin-tools-a-l.md). Builtin tools are TypeScript functions defined in `services/agent-claw/src/tools/builtins/` via `defineTool({ id, description, inputSchema, outputSchema, annotations })`.

**Schema validation:** All inputs are validated by Zod before `execute()` runs. Type errors return a structured error to the agent, not an exception. Outputs are also schema-validated.

**Annotation key:**
- `readOnly: true` — No state mutations to Postgres or any downstream system
- `readOnly: false` — May INSERT/UPDATE or call state-mutating MCP endpoints

**Tool count (M–Z, excluding QM):** 57 tools

---

### manage_plan

**File:** `manage_plan.ts` | **Annotation:** `readOnly: false` | **Internal:** `is_internal: true`

Manages the agent's DB-backed plan stored in `agent_plans`. Requires `session_id` in `ctx.scratchpad`; throws if absent. The tool refuses to mutate `current_step_index` — step advancement is handled by the harness, not by the agent directly.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | `"insert" \| "remove" \| "replace" \| "inspect"` | Yes | Discriminant for which operation to perform |
| `steps` | `string[]` | insert | List of step descriptions to append |
| `index` | `number (int ≥ 0)` | remove / replace | Zero-based index of the step to target |
| `step` | `string` | replace | New step description for the targeted index |

#### Output

| Field | Type | Description |
|---|---|---|
| `plan_id` | `string (uuid)` | Identifier of the plan row |
| `steps` | `string[]` | Full step list after the operation |
| `current_step_index` | `number (int)` | Current execution cursor (read-only) |
| `notice` | `string \| null` | Advisory message (e.g. `remove_out_of_range`) |

#### Behavior notes

- `insert`: appends steps to the end of the existing list.
- `remove`: removes the step at `index`; returns `notice: "remove_out_of_range"` when `index` exceeds the list length rather than throwing.
- `replace`: overwrites the step at `index` with `step`.
- `inspect`: returns the current plan state without modification.
- All mutations go through the `plan-store-db` module, which persists to `agent_plans` via `withUserContext`.

---

### manage_todos

**File:** `manage_todos.ts` | **Annotation:** `readOnly: false` | **Internal:** `is_internal: true`

Creates and tracks checklist items in `agent_todos`. Intended for any task spanning three or more steps. Dispatches `task_created` and `task_completed` lifecycle hooks after the relevant mutations, enabling live UI updates via `todo_update` SSE events.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `action` | `"create" \| "update" \| "complete" \| "cancel" \| "list"` | Yes | Operation to perform |
| `title` | `string` | create | Short description of the task |
| `todo_id` | `string (uuid)` | update / complete / cancel | Target todo |
| `notes` | `string` | update | Free-form progress notes |

#### Output

| Field | Type | Description |
|---|---|---|
| `todos` | `Todo[]` | Full list of todos for the current session after the operation |
| `action_applied` | `string` | Echo of the action that was performed |

#### Behavior notes

- `complete` and `cancel` are terminal — re-applying them is a no-op.
- `list` returns the current state without side effects.
- The exported `isManageTodosOutput` type guard performs a structural array check and is used by the harness to identify tool results that carry todo state.

---

### mark_research_done

**File:** `mark_research_done.ts` | **Annotation:** `readOnly: false`

**Terminal tool.** Signals the end of a research session by inserting a row into `research_reports` and emitting a `research_done` SSE event. The agent must call this before ending a research-oriented turn; calling it is a prerequisite for the harness to close the research lifecycle.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string (max 200)` | Yes | Report title; also used to derive the URL slug |
| `summary` | `string (max 4000)` | Yes | Executive summary of findings |
| `sections` | `Section[]` | Yes | Structured report body (heading + content per section) |
| `cited_fact_ids` | `string[] (uuid[])` | No | KG fact IDs referenced in the report |
| `cited_chunk_ids` | `string[]` | No | Document chunk IDs referenced in the report |

#### Output

| Field | Type | Description |
|---|---|---|
| `report_id` | `string (uuid)` | Inserted row ID |
| `slug` | `string` | URL-safe slug derived from title (max 60 chars) |
| `markdown` | `string` | Rendered Markdown of the full report |

#### Behavior notes

- Slug generation uses the exported `_slugify` helper (lowercases, strips non-alphanumeric, truncates to 60 chars).
- Report Markdown is assembled by the exported `_buildMarkdown` helper.
- Persisted via `withUserContext` (RLS-scoped to the calling user).

---

### match_smarts_catalog

**File:** `match_smarts_catalog.ts` | **Annotation:** `readOnly: true`

Screens one or more SMILES strings against the `compound_smarts_catalog` table. Each catalog rule is an (id, name, smarts, severity, category) tuple. Matching uses mcp-rdkit `/tools/substructure_match` for RDKit-correct SMARTS semantics.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `smiles_list` | `string[] (min 1, max 200)` | Yes | SMILES to screen |
| `categories` | `string[]` | No | Restrict catalog to these category names |
| `severity_min` | `string` | No | Minimum severity level to include |

#### Output

| Field | Type | Description |
|---|---|---|
| `matches` | `CatalogMatch[]` | All positive matches across all inputs |
| `n_rules_checked` | `number (int)` | Number of catalog rules evaluated |
| `n_smiles` | `number (int)` | Number of input SMILES evaluated |

Each `CatalogMatch` includes `smiles`, `rule_id`, `rule_name`, `smarts`, `severity`, `category`, and `atom_indices`.

#### Behavior notes

- Catalog rows are fetched via `withSystemContext` (globally visible, not RLS-scoped per project).
- Errors from individual rule evaluations are logged at `warn` level and skipped; the batch continues.
- Timeout: 30 s per mcp-rdkit call.

---

### materialize_chrom_method

**File:** `materialize_chrom_method.ts` | **Annotation:** `readOnly: false`

Converts a chromatography optimization proposal (from `optimization_rounds`) into a concrete `analytical_methods` row. Reads the round and the specific proposal under RLS, calls mcp-chrom-method-optimizer `/materialize_method`, then inserts the resulting method definition.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `round_id` | `string (uuid)` | Yes | Optimization round containing the proposal |
| `proposal_index` | `number (int ≥ 0)` | Yes | Index into the round's proposals array |
| `method_name` | `string (max 200)` | Yes | Human-readable name for the new method |
| `column_id` | `string (uuid)` | Yes | Column inventory entry to use |

#### Output

| Field | Type | Description |
|---|---|---|
| `method_id` | `string (uuid)` | Inserted `analytical_methods` row ID |
| `method_name` | `string` | Confirmed method name |
| `gradient_steps` | `GradientStep[]` | Resolved gradient program |
| `flow_rate_ml_min` | `number` | Final flow rate |

#### Behavior notes

- The `column_id` must refer to an `active` column in `column_inventory`; the tool throws `column_not_active` otherwise.
- Timeout: 15 s for the mcp-chrom-method-optimizer call.
- Persisted via `withUserContext`.

---

### pause_optimization_campaign

**File:** `optimization_campaign_lifecycle.ts` | **Annotation:** `readOnly: false`

Transitions an optimization campaign from `active` to `paused`. Uses `SELECT FOR UPDATE` to prevent concurrent transitions and increments `etag` on success.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `campaign_id` | `string (uuid)` | Yes | Campaign to pause |
| `reason` | `string (max 500)` | No | Optional human note for the pause |

#### Output

| Field | Type | Description |
|---|---|---|
| `campaign_id` | `string (uuid)` | Echoed campaign ID |
| `previous_status` | `string` | Status before the transition (`active`) |
| `new_status` | `string` | Status after the transition (`paused`) |
| `etag` | `number (int)` | New etag value |

#### Behavior notes

- Idempotent: transitioning a campaign that is already `paused` returns success without bumping `etag`.
- Shares the `transitionCampaign` helper with `resume_optimization_campaign` and `complete_optimization_campaign`.
- Throws `campaign_not_found` if the campaign does not exist under RLS.

---

### resume_optimization_campaign

**File:** `optimization_campaign_lifecycle.ts` | **Annotation:** `readOnly: false`

Transitions an optimization campaign from `paused` back to `active`. See `pause_optimization_campaign` for the shared transition contract.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `campaign_id` | `string (uuid)` | Yes | Campaign to resume |
| `reason` | `string (max 500)` | No | Optional human note for the resumption |

#### Output

Same shape as `pause_optimization_campaign`; `previous_status` will be `paused`, `new_status` will be `active`.

#### Behavior notes

- Idempotent: resuming an already-`active` campaign is a no-op.
- Uses the same `transitionCampaign` helper and `SELECT FOR UPDATE` concurrency guard.

---

### complete_optimization_campaign

**File:** `optimization_campaign_lifecycle.ts` | **Annotation:** `readOnly: false`

Terminates an optimization campaign by transitioning it to `completed` or `aborted`. Accepts campaigns in `active` or `paused` state.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `campaign_id` | `string (uuid)` | Yes | Campaign to close |
| `terminal_status` | `"completed" \| "aborted"` | Yes | Final status to assign |
| `reason` | `string (max 500)` | No | Outcome summary or abort reason |

#### Output

| Field | Type | Description |
|---|---|---|
| `campaign_id` | `string (uuid)` | Echoed campaign ID |
| `previous_status` | `string` | Status before the transition |
| `new_status` | `string` | `completed` or `aborted` |
| `etag` | `number (int)` | New etag value |
| `outcome_summary_recorded` | `boolean` | Always `false` pending a schema migration for long-form summaries |

---

### predict_molecular_property

**File:** `predict_molecular_property.ts` | **Annotation:** `readOnly: true` | **Result schema:** `predict_property.v1`

Predicts physicochemical properties for a list of SMILES using the chemprop v2 MPNN model via mcp-chemprop `/predict_property`. Supported properties: `logP`, `logS`, `mp` (melting point °C), `bp` (boiling point °C).

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `smiles_list` | `string[] (min 1, max 100)` | Yes | SMILES to evaluate (each max `MAX_SMILES_LEN` chars) |
| `property` | `"logP" \| "logS" \| "mp" \| "bp"` | Yes | Property to predict |

#### Output

| Field | Type | Description |
|---|---|---|
| `predictions` | `PropertyPrediction[]` | One entry per input SMILES |
| `property` | `string` | Echoed property name |
| `model_id` | `string` | Identifier of the chemprop checkpoint used |

Each `PropertyPrediction` includes `smiles`, `predicted_value`, and `std`.

#### Behavior notes

- Timeout: 60 s.
- Input SMILES are forwarded verbatim to chemprop; canonicalization is the caller's responsibility if needed.

---

### predict_reaction_yield

**File:** `predict_reaction_yield.ts` | **Annotation:** `readOnly: true` | **Result schema:** `predict_yield.v1`

Predicts expected yield (0–100) and uncertainty for a list of reaction SMILES using the chemprop v2 MPNN model. Delegates to mcp-chemprop `/predict_yield`.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `rxn_smiles_list` | `string[] (min 1, max 100)` | Yes | Reaction SMILES in `reactants>>products` format |

#### Output

| Field | Type | Description |
|---|---|---|
| `predictions` | `YieldPrediction[]` | One entry per input reaction SMILES |

Each `YieldPrediction` includes `rxn_smiles`, `predicted_yield` (0–100), `std`, and `model_id`.

#### Behavior notes

- Timeout: 60 s.
- For per-project fine-tuned predictions with a combined uncertainty estimate, use `predict_yield_with_uq` instead.

---

### predict_yield_with_uq

**File:** `predict_yield_with_uq.ts` | **Annotation:** `readOnly: true` | **Result schema:** `train.v1`

Predicts yield with calibrated uncertainty using a chemprop + per-project XGBoost ensemble. Combines chemprop's MVE-head standard deviation (aleatoric uncertainty) with chemprop–XGBoost disagreement (epistemic uncertainty) into a single `ensemble_std`. Exports `PredictServerOut` for callers (such as `design_plate`) that validate the server response directly.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `rxn_smiles_list` | `string[] (min 1, max 100)` | Yes | Reaction SMILES to predict |
| `project_internal_id` | `string (max 200)` | No | Project to source per-project training data from |

#### Output

| Field | Type | Description |
|---|---|---|
| `predictions` | `ReactionPrediction[]` | Per-SMILES predictions with component breakdown |
| `model_id` | `string \| null` | Trained model ID, or null when global fallback is used |
| `n_train` | `number (int)` | Number of training pairs used; 0 for global fallback |
| `used_global_fallback` | `boolean` | True when the project had fewer than 50 labeled reactions |

Each `ReactionPrediction` includes `rxn_smiles`, `ensemble_mean`, `ensemble_std`, and a `components` object with `chemprop_mean`, `chemprop_std`, and `xgboost_mean`.

#### Behavior notes

- Training data is fetched from `reactions_current` (a view that excludes invalidated and superseded reactions), scoped under RLS to the calling user.
- The XGBoost per-project model requires at least 50 labeled reactions (`MIN_TRAIN_PAIRS`); projects below this threshold fall back to the global pretrained chemprop model.
- HTTP 412 from the prediction endpoint (cache miss after server restart) triggers one automatic re-train followed by a single retry.
- Maximum training pairs: 10,000 (`MAX_TRAIN_PAIRS`).

---

### promote_to_kg

**File:** `promote_to_kg.ts` | **Annotation:** `readOnly: false`

Inserts an extracted fact into the knowledge graph (`facts` table) and fires an `extracted_fact` ingestion event in a single transaction. The confidence score is capped based on the fact class to prevent overconfident machine-generated claims.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `subject` | `string` | Yes | KG entity the fact is about |
| `predicate` | `string` | Yes | Relationship or property name |
| `object` | `string` | Yes | Value or target entity |
| `fact_class` | `"INTERPRETED" \| "HYPOTHESIZED" \| "ABSTRACTED"` | Yes | Epistemic classification |
| `confidence` | `number (0–1)` | Yes | Confidence score (capped by class) |
| `source_chunk_id` | `string` | No | Document chunk that supports this fact |
| `source_experiment_id` | `string (uuid)` | No | Experiment that supports this fact |

#### Output

| Field | Type | Description |
|---|---|---|
| `fact_id` | `string (uuid)` | Inserted fact row ID |
| `confidence_tier` | `string` | Derived tier: `high / medium / low / exploratory` |
| `capped` | `boolean` | True if the supplied confidence was reduced by the class cap |

#### Behavior notes

- **Class confidence caps:** `INTERPRETED ≤ 0.95`, `HYPOTHESIZED ≤ 0.80`, `ABSTRACTED ≤ 0.70`.
- **Tier derivation:** `≥ 0.85 → high`, `≥ 0.65 → medium`, `≥ 0.40 → low`, else `exploratory`.
- The `facts` INSERT and the `ingestion_events` INSERT occur within the same `withUserContext` transaction.

---

### promote_workflow_to_tool

**File:** `promote_workflow_to_tool.ts` | **Annotation:** `readOnly: false`

Promotes a named workflow definition to a `skill_library` entry of kind `forged_tool`, making it invocable as a reusable agent skill. Restricted to admins for non-private scopes.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `workflow_name` | `string` | Yes | Name of the workflow to promote |
| `skill_name` | `string` | Yes | Identifier for the new skill |
| `description` | `string` | Yes | Human-readable skill description |
| `scope` | `"private" \| "project" \| "org" \| "global"` | Yes | Visibility scope |
| `scope_id` | `string` | No | Project or org ID for non-private scopes |

#### Output

| Field | Type | Description |
|---|---|---|
| `skill_id` | `string (uuid)` | Inserted `skill_library` row ID |
| `skill_name` | `string` | Confirmed skill identifier |

#### Behavior notes

- Non-`private` scopes require `global_admin`, `org_admin`, or `project_admin` role; the tool checks via `requireAdmin`.
- Every call is audited via `appendAudit` with action `workflow_tool.promote`.
- Reads the workflow definition via `withSystemContext`; inserts the skill via the same connection.

---

### propose_hypothesis

**File:** `propose_hypothesis.ts` | **Annotation:** `readOnly: false`

Records a scientific hypothesis in the `hypotheses` table along with its supporting fact citations. Enforces anti-fabrication: every cited fact ID must have been seen in the current session's scratchpad.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `statement` | `string (max 2000)` | Yes | The hypothesis in plain language |
| `confidence` | `number (0–1)` | Yes | Estimated confidence at proposal time |
| `cited_fact_ids` | `string[] (uuid[])` | Yes | IDs of KG facts supporting this hypothesis |
| `tags` | `string[]` | No | Optional classification tags |

#### Output

| Field | Type | Description |
|---|---|---|
| `hypothesis_id` | `string (uuid)` | Inserted row ID |
| `confidence_tier` | `string` | Derived tier using the same thresholds as `promote_to_kg` |

#### Behavior notes

- **Anti-fabrication HARD GUARD:** If any `cited_fact_id` is not present in `ctx.scratchpad.seenFactIds`, the tool throws an error and does not insert. The agent must have retrieved the cited facts via `query_kg` or similar tools in the same session.
- The `hypotheses` INSERT, `hypothesis_citations` INSERT (with `ON CONFLICT DO NOTHING`), and an `ingestion_events` row (`hypothesis_proposed`) are all written in a single `withUserContext` transaction.

---

### propose_retrosynthesis

**File:** `propose_retrosynthesis.ts` | **Annotation:** `readOnly: true` | **Result schema:** `retrosynthesis.v1`

Proposes multi-step retrosynthesis routes for a target SMILES. Uses ASKCOS v2 by default; automatically falls back to AiZynthFinder when ASKCOS times out or returns HTTP 503.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `smiles` | `string (max 10,000)` | Yes | Target molecule SMILES |
| `max_depth` | `number (int 1–6)` | No | Maximum retrosynthesis tree depth (default 3) |
| `max_branches` | `number (int 1–10)` | No | Maximum branches per node (default 4) |
| `prefer_aizynth` | `boolean` | No | Skip ASKCOS and go directly to AiZynthFinder (default false) |

#### Output

| Field | Type | Description |
|---|---|---|
| `source` | `"askcos" \| "aizynth"` | Which engine produced the result |
| `routes_askcos` | `AskcosRoute[]` | Routes from ASKCOS (when source is askcos) |
| `routes_aizynth` | `AiZynthRoute[]` | Routes from AiZynthFinder (when source is aizynth) |
| `fallback_reason` | `string` | Set when ASKCOS was tried but bypassed (e.g. `"askcos timed out"`) |

#### Behavior notes

- ASKCOS timeout: 30 s. AiZynthFinder timeout: 60 s.
- Only `AbortError` (timeout) and HTTP 503 trigger the fallback; other ASKCOS errors propagate.
- AiZynthFinder receives `max_iterations: 100`; depth and branch parameters are not forwarded.

---

### pubchem_ghs_lookup

**File:** `pubchem_ghs_lookup.ts` | **Annotation:** `readOnly: true` | **Open world:** `openWorld: true`

Retrieves GHS (Globally Harmonized System) safety data for a compound from the PubChem PUG-View API. No authentication required; queries a public external endpoint.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `smiles` | `string` | Yes | SMILES of the compound to look up |

#### Output

| Field | Type | Description |
|---|---|---|
| `cid` | `number \| null` | PubChem Compound ID, null if not found |
| `has_ghs_data` | `boolean` | Whether PubChem holds GHS data for this compound |
| `hazard_statements` | `string[]` | H-code statements (e.g. `"H301 - Toxic if swallowed"`) |
| `precautionary_statements` | `string[]` | P-code statements |
| `signal_word` | `string \| null` | `"Danger"`, `"Warning"`, or null |
| `pictograms` | `string[]` | GHS pictogram names |

#### Behavior notes

- Resolution pipeline: SMILES → mcp-rdkit canonicalization → InChIKey → PubChem CID lookup → GHS view fetch.
- `has_ghs_data: false` means the compound's safety profile is **unknown**, not that it is safe.
- GHS data is extracted from the PUG-View JSON by the exported `extractGhsFromView` helper (regex walk over the TOC tree).
- Timeout: 15 s total across both external calls.

---

### query_chrom_columns

**File:** `query_chrom_columns.ts` | **Annotation:** `readOnly: true`

Returns chromatography column inventory entries with their 6-axis Tanaka parameter vectors. Used to select compatible columns for method optimization campaigns.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `active_only` | `boolean` | No | Restrict to columns with status `active` (default true) |
| `manufacturer` | `string` | No | Filter by column manufacturer name |
| `phase_type` | `string` | No | Filter by stationary phase type |

#### Output

| Field | Type | Description |
|---|---|---|
| `columns` | `ChromColumn[]` | Matching column inventory entries |
| `n_incomplete` | `number (int)` | Count of rows filtered out due to incomplete Tanaka vectors |

Each `ChromColumn` includes `id`, `name`, `manufacturer`, `phase_type`, `active`, and a `tanaka` object with the 6 Tanaka parameters: `hydrophobicity`, `shape_selectivity`, `hydrogen_bond_acidity`, `hydrogen_bond_basicity`, `ion_exchange_acidity`, `ion_exchange_basicity`.

#### Behavior notes

- Queries `column_inventory` directly via `pool.connect()` (not via `withUserContext`; column inventory is globally visible).
- Rows with any of the 6 Tanaka vector fields null are excluded and counted in `n_incomplete`.

---

### query_eln_canonical_reactions

**File:** `query_eln_canonical_reactions.ts` | **Annotation:** `readOnly: true`

Queries the local ELN mock for canonical reaction records. Returns reactions in the shared `CanonicalReactionSchema` format (imported from `_eln_shared.js`).

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `project_id` | `string` | No | Filter by ELN project |
| `compound_id` | `string` | No | Filter reactions involving this compound |
| `reaction_type` | `string` | No | Filter by reaction class |
| `limit` | `number (int, max 200)` | No | Maximum results (default 50) |

#### Output

| Field | Type | Description |
|---|---|---|
| `reactions` | `CanonicalReaction[]` | Matching reaction records |
| `total` | `number (int)` | Total matching count (may exceed `limit`) |

#### Behavior notes

- Delegates to mcp-eln-local `/reactions/query`. Timeout: 15 s.
- The `CanonicalReaction` schema is the shared contract across ELN-sourcing tools; it includes `rxn_smiles`, `rxno_class`, `conditions`, and `yield_pct`.

---

### query_eln_experiments

**File:** `query_eln_experiments.ts` | **Annotation:** `readOnly: true`

Queries the local ELN mock for experiment entries. Supports keyset pagination for iterating large result sets.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `project_id` | `string` | No | Filter by ELN project |
| `status` | `string` | No | Filter by experiment status |
| `limit` | `number (int, max 200)` | No | Page size (default 50) |
| `cursor` | `string` | No | Keyset cursor from the previous page's `next_cursor` |

#### Output

| Field | Type | Description |
|---|---|---|
| `experiments` | `Experiment[]` | Matching experiment records |
| `next_cursor` | `string \| null` | Cursor to retrieve the next page; null on the last page |
| `total` | `number (int)` | Total matching count |

#### Behavior notes

- Delegates to mcp-eln-local `/experiments/query`. Timeout: 15 s.
- Pass `next_cursor` from a prior response as `cursor` to page through results.

---

### query_eln_samples_by_entry

**File:** `query_eln_samples_by_entry.ts` | **Annotation:** `readOnly: true`

Retrieves all samples associated with a specific ELN notebook entry.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `entry_id` | `string` | Yes | ELN notebook entry ID |

#### Output

| Field | Type | Description |
|---|---|---|
| `samples` | `Sample[]` | All samples linked to the entry |
| `entry_id` | `string` | Echoed entry ID |

#### Behavior notes

- Delegates to mcp-eln-local `/samples/by_entry`. Timeout: 15 s.

---

### query_instrument_datasets

**File:** `query_instrument_datasets.ts` | **Annotation:** `readOnly: true`

Retrieves instrument datasets associated with a sample from the SciY LIMS integration (mcp-logs-sciy).

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `sample_id` | `string` | Yes | Sample identifier to look up datasets for |

#### Output

| Field | Type | Description |
|---|---|---|
| `datasets` | `InstrumentDataset[]` | Datasets associated with the sample |
| `valid_until` | `string (ISO 8601)` | Cache expiry timestamp for this result |

#### Behavior notes

- Delegates to mcp-logs-sciy `/datasets/by_sample`. Timeout: 20 s.
- The `valid_until` timestamp reflects the SciY cache window; callers should re-query after this time for fresh data.

---

### query_instrument_persons

**File:** `query_instrument_persons.ts` | **Annotation:** `readOnly: true`

Looks up operator/analyst person records from the SciY instrument system.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `name_contains` | `string` | No | Substring filter on person name |
| `limit` | `number (int, max 100)` | No | Maximum results (default 20) |

#### Output

| Field | Type | Description |
|---|---|---|
| `persons` | `InstrumentPerson[]` | Matching person records |

Each `InstrumentPerson` includes `id`, `name`, and `email`.

#### Behavior notes

- Delegates to mcp-logs-sciy `/persons/query`. Timeout: 15 s.

---

### query_instrument_runs

**File:** `query_instrument_runs.ts` | **Annotation:** `readOnly: true`

Queries instrument run records from SciY with keyset pagination ordered by measurement time descending.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `instrument_id` | `string` | No | Filter by instrument |
| `person_id` | `string` | No | Filter by operator |
| `from_time` | `string (ISO 8601)` | No | Start of time window |
| `to_time` | `string (ISO 8601)` | No | End of time window |
| `limit` | `number (int, max 200)` | No | Page size (default 50) |
| `cursor` | `string` | No | Keyset cursor from a prior response |

#### Output

| Field | Type | Description |
|---|---|---|
| `runs` | `InstrumentRun[]` | Matching instrument run records |
| `next_cursor` | `string \| null` | Cursor for the next page |

#### Behavior notes

- Delegates to mcp-logs-sciy `/datasets/query`. Timeout: 20 s.
- Keyset pagination key is `(measured_at DESC, uid)`.

---

### query_kg

**File:** `query_kg.ts` | **Annotation:** `readOnly: true`

Queries the bi-temporal knowledge graph for facts incident to an entity. Returns all edges whose subject or object matches the entity reference, filtered by optional predicate and direction. Fact IDs returned are tracked by the `anti-fabrication` post_tool hook for use in subsequent `propose_hypothesis` calls.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `entity` | `EntityRef` | **Yes** | Entity to query: `{ label: string (CamelCase, ≤80), id_property: string (snake_case, ≤40), id_value: string (≤4000) }` |
| `predicate` | `string` | No | Filter by predicate type (UPPER_SNAKE_CASE, max 80) |
| `direction` | `"in" \| "out" \| "both"` | No | Traversal direction (default: `"both"`) |
| `at_time` | `string (ISO-8601 with offset)` | No | Query KG at this historical timestamp; omit for current state |
| `include_invalidated` | `boolean` | No | Include invalidated facts (default: `false`) |
| `group_id` | `string` | No | Restrict to a specific tenant KG group (server default: `"__system__"`) |

#### Output

| Field | Type | Description |
|---|---|---|
| `facts` | `KgFact[]` | Matching facts with full provenance, confidence tier/score, and bi-temporal bounds |

Each `KgFact` contains: `fact_id (UUID)`, `subject (EntityRef)`, `predicate`, `object (EntityRef)`, `edge_properties (record)`, `confidence_tier` (one of `expert_validated | multi_source_llm | single_source_llm | expert_disputed | invalidated`), `confidence_score (number)`, `t_valid_from`, `t_valid_to (nullable)`, `recorded_at`, `provenance { source_type, source_id }`.

#### Behavior notes

- Delegates to mcp-kg `/tools/query_at_time`. Timeout: 20 s.
- For a mandatory historical snapshot, prefer `query_kg_at_time` which requires `at_time`.
- Fact IDs are accumulated into `ctx.scratchpad.seenFactIds` by the `anti-fabrication` post_tool hook, not by this tool directly.

---

### query_kg_at_time

**File:** `query_kg_at_time.ts` | **Annotation:** `readOnly: true`

Time-travel KG query: identical to `query_kg` except that `at_time` is required, making the temporal snapshot semantics explicit. Use when the agent needs to reason about historical KG state.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `entity` | `EntityRef` | **Yes** | Entity to query: `{ label, id_property, id_value }` |
| `at_time` | `string (ISO-8601 with offset)` | **Yes** | Historical timestamp for the KG snapshot |
| `predicate` | `string` | No | Filter by predicate type (UPPER_SNAKE_CASE, max 80) |
| `direction` | `"in" \| "out" \| "both"` | No | Traversal direction (default: `"both"`) |
| `include_invalidated` | `boolean` | No | Include facts invalidated by `at_time` (default: `false`) |
| `group_id` | `string` | No | Restrict to a specific tenant KG group |

#### Output

Same as `query_kg` — `{ facts: KgFact[] }`.

#### Behavior notes

- Delegates to mcp-kg `/tools/query_at_time`. Timeout: 20 s.

---

### query_lims_results

**File:** `query_lims_results.ts` | **No annotations specified**

> **Status: pending registration.** This tool file exists but is not yet wired into `dependencies.ts` and will not appear in the agent's live tool list. It is documented here for completeness; it becomes active once registered.

Queries STARLIMS for analytical test results matching filter criteria. Automatically constructs a `Citation` per result referencing the LIMS record.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `sample_id` | `string` | No | LIMS sample identifier |
| `test_name` | `string` | No | Analytical test name filter |
| `from_date` | `string (ISO 8601)` | No | Start of date window |
| `to_date` | `string (ISO 8601)` | No | End of date window |
| `status` | `string` | No | Result status filter (e.g. `"approved"`) |
| `limit` | `number (int, max 500)` | No | Maximum results (default 100) |

#### Output

| Field | Type | Description |
|---|---|---|
| `results` | `LimsResult[]` | Matching test results with citations |
| `total` | `number (int)` | Total matching count |

Each `LimsResult` includes a `citation` object with `source_kind`, `source_system_id`, and `url`.

#### Behavior notes

- Delegates to mcp-lims-starlims `/query_results`. Timeout: 20 s.

---

### query_provenance

**File:** `query_provenance.ts` | **Annotation:** `readOnly: true`

Retrieves provenance metadata for a specific KG fact — who created it, from what source, and when.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `fact_id` | `string (uuid)` | Yes | KG fact to retrieve provenance for |

#### Output

| Field | Type | Description |
|---|---|---|
| `fact_id` | `string (uuid)` | Echoed fact ID |
| `source_type` | `string` | One of: `ELN / SOP / literature / analytical / user_correction / agent_inference / import_tool` |
| `created_at` | `string (ISO 8601)` | When the fact was recorded |
| `created_by` | `string \| null` | User or agent that created the fact |
| `source_document_id` | `string \| null` | Source document if applicable |
| `notes` | `string \| null` | Free-form provenance notes |

#### Behavior notes

- Delegates to mcp-kg `/tools/get_fact_provenance`. Timeout: 10 s.

---

### query_source_cache

**File:** `query_source_cache.ts` | **Annotation:** `readOnly: true`

Looks up cached source-system data from the KG using a composite key of `source_system_id` and `subject_id`. Supports client-side freshness filtering.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `source_system_id` | `string` | Yes | Identifier for the source system (e.g. `"eln-local"`) |
| `subject_id` | `string` | Yes | Subject identifier within that system |
| `freshness_window_days` | `number` | No | Reject cached entries older than this many days |

#### Output

| Field | Type | Description |
|---|---|---|
| `found` | `boolean` | Whether a cache entry was found and is within the freshness window |
| `entity` | `SourceEntity \| null` | Cached entity data when found |
| `cached_at` | `string \| null` | When the cache entry was written |

#### Behavior notes

- Constructs the KG composite key as `${source_system_id}:${subject_id}` and queries via mcp-kg `/tools/query_at_time`.
- `freshness_window_days` is applied client-side by comparing `edge_properties.valid_until` to the current time.
- Timeout: 10 s.

---

### read_article

**File:** `read_article.ts` | **Annotation:** `readOnly: true`

Reads a knowledge wiki article by slug. Optionally retrieves a historical revision. Returns the article body, metadata, and inline citations. Gated by the `wiki.enabled` feature flag.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `slug` | `string` | Yes | URL-safe article slug |
| `revision` | `number (int ≥ 1)` | No | Historical revision number; omit for the current version |

#### Output

| Field | Type | Description |
|---|---|---|
| `article_id` | `string (uuid)` | Article row ID |
| `slug` | `string` | Confirmed slug |
| `title` | `string` | Article title |
| `kind` | `string` | Article kind (`topic / glossary / contradiction / procedure / safety`) |
| `body_md` | `string` | Article body in Markdown |
| `revision` | `number (int)` | Revision number returned |
| `citations` | `ArticleCitation[]` | Inline citations parsed from the body |
| `has_human_edits` | `boolean` | True if the article contains human-curated content |
| `dirty` | `boolean` | True if the article is flagged for regeneration |

#### Behavior notes

- Feature-gated: calls `assertWikiEnabled(ctx)` and throws `wiki_disabled` if the `wiki.enabled` flag is off.
- Historical revisions are read from `knowledge_article_revisions`; the current version from `knowledge_articles` + `knowledge_article_citations`.
- RLS-scoped via `withUserContext`.

---

### read_file

**File:** `read_file.ts` | **Annotation:** `readOnly: true`

Reads a file within the agent's sandboxed filesystem (`AGENT_FS_ROOT`). Supports line-range slicing for large files.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | File path (resolved relative to `AGENT_FS_ROOT`) |
| `start_line` | `number (int ≥ 1)` | No | First line to return (1-indexed) |
| `line_count` | `number (int ≥ 1)` | No | Number of lines to return from `start_line` |

#### Output

| Field | Type | Description |
|---|---|---|
| `content` | `string` | File contents (or the requested line slice) |
| `total_lines` | `number (int)` | Total line count of the file |
| `complete` | `boolean` | False when the response was truncated due to size limits |
| `size_bytes` | `number (int)` | File size in bytes |

#### Behavior notes

- Path is validated via `resolveAndCheckPath`, which rejects traversal outside `AGENT_FS_ROOT`.
- Full-file reads are capped at 1 MiB; sliced reads (`start_line` + `line_count`) are capped at 8 MiB.
- Requires `AGENT_FS_TOOLS_ENABLED=true`; throws `fs_tools_disabled` otherwise.

---

### recommend_conditions

**File:** `recommend_conditions.ts` | **Annotation:** `readOnly: true`

Recommends reaction conditions (catalyst, reagents, solvent, temperature) for a given reaction SMILES using the ASKCOS `/recommend_conditions` endpoint.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `rxn_smiles` | `string` | Yes | Reaction SMILES in `reactants>>products` format |
| `n_conditions` | `number (int 1–20)` | No | Number of condition sets to return (default 5) |

#### Output

| Field | Type | Description |
|---|---|---|
| `conditions` | `ConditionSet[]` | Ranked condition recommendations |

Each `ConditionSet` includes `catalyst`, `reagents` (list), `solvents` (list), `temperature_c`, and `score`.

#### Behavior notes

- Delegates to mcp-askcos `/recommend_conditions`. Timeout: 60 s.

---

### recommend_next_batch

**File:** `recommend_next_batch.ts` | **Annotation:** `readOnly: false`

Proposes the next round of experiments for a Bayesian optimization campaign. Reads prior measured outcomes under RLS, calls mcp-reaction-optimizer `/recommend_next`, inserts a new `optimization_rounds` row, and bumps the campaign `etag`.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `campaign_id` | `string (uuid)` | Yes | Campaign to advance |
| `n_candidates` | `number (int 1–200)` | No | Number of candidates to propose (default 8) |
| `seed` | `number (int)` | No | Override seed; derived deterministically from `(campaign.seed, round_index)` if omitted |
| `min_distance_from_measured` | `number (0–1)` | No | Gower distance threshold for deduplication against prior measurements; falls back to config key `bo.min_distance_from_measured` |

#### Output

| Field | Type | Description |
|---|---|---|
| `campaign_id` | `string (uuid)` | Echoed campaign ID |
| `round_id` | `string (uuid)` | Inserted `optimization_rounds` row ID |
| `round_index` | `number (int)` | Zero-based round number |
| `n_observations` | `number (int)` | Number of prior measured outcomes used for fitting |
| `used_bo` | `boolean` | False when cold-start or BO fallback occurred |
| `fallback_reason` | `string \| null` | Set when the BO path was bypassed |
| `strategy` | `string` | BoFire strategy name used |
| `acquisition` | `string` | Acquisition function name used |
| `proposals` | `Proposal[]` | Proposed experimental conditions |

#### Behavior notes

- **Concurrency control:** acquires a per-campaign `pg_advisory_xact_lock` for the full read–fit–insert sequence, preventing duplicate round indices from parallel callers.
- **Cold-start:** campaigns with fewer than `bo.min_observations_for_bo` (config key, default 3) measured outcomes receive space-filling random samples instead of BO proposals.
- **Per-round seed derivation:** `SHA-256(campaign.seed || ":" || round_index)`, taking 31 bits for numpy/torch compatibility.
- **OTel sub-span:** `bo.recommend_next` span records campaign ID, round index, observation count, strategy, acquisition, multi-objective flag, and wall-clock duration.
- **Fallback audit:** BO fallback to random (`random_*_failed` source) is logged at `warn` and written to `record_error_event` via a SAVEPOINT-wrapped call (an audit write failure does not roll back the inserted round).
- `bofire_domain` is validated as a non-null object before forwarding to the optimizer.
- Campaign `etag` is bumped within the same advisory-locked transaction as the round INSERT.

---

### recommend_next_chrom_batch

**File:** `recommend_next_chrom_batch.ts` | **Annotation:** `readOnly: false`

Mirrors `recommend_next_batch` for chromatography method optimization campaigns. Calls mcp-chrom-method-optimizer `/recommend_next` and inserts a new round.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `campaign_id` | `string (uuid)` | Yes | Chromatography campaign to advance |
| `n_candidates` | `number (int 1–50)` | No | Number of method candidates to propose (default 4) |
| `seed` | `number (int)` | No | Fixed seed (not derived; omit for optimizer default) |

#### Output

| Field | Type | Description |
|---|---|---|
| `campaign_id` | `string (uuid)` | Echoed campaign ID |
| `round_id` | `string (uuid)` | Inserted round row ID |
| `round_index` | `number (int)` | Round number |
| `proposals` | `Proposal[]` | Proposed method conditions |

#### Behavior notes

- No per-campaign advisory lock (chromatography campaigns are single-user by design).
- No OTel sub-span and no SAVEPOINT-wrapped audit (simpler than `recommend_next_batch`).
- Timeout: 120 s.

---

### record_synthesis_campaign_outcome

**File:** `record_synthesis_campaign_outcome.ts` | **Annotation:** `readOnly: false`

Closes a synthesis campaign by transitioning it to a terminal status and recording the outcome. Optionally records final measurements.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `campaign_id` | `string (uuid)` | Yes | Campaign to close |
| `outcome` | `"success" \| "partial_success" \| "failure" \| "cancelled"` | Yes | Final outcome classification |
| `summary` | `string (max 2000)` | No | Narrative summary of the campaign outcome |
| `measurements` | `Measurement[]` | No | Final analytical measurements to record |

#### Output

| Field | Type | Description |
|---|---|---|
| `campaign_id` | `string (uuid)` | Echoed campaign ID |
| `status` | `string` | Terminal status applied to the campaign |
| `event_type` | `string` | Emitted event (`campaign_completed`, `campaign_aborted`, or `campaign_status_changed`) |
| `measurements_recorded` | `number (int)` | Count of additional measurement events emitted |
| `etag` | `number (int)` | New campaign etag |

#### Behavior notes

- Campaign must be in a non-terminal state; attempting to close an already-closed campaign throws.
- `measurements` triggers additional `measurement_recorded` ingestion events within the same transaction.

---

### request_article

**File:** `request_article.ts` | **Annotation:** `readOnly: false`

Requests creation or regeneration of a knowledge wiki article. Creates a stub article (revision 1, `dirty=true`) if the slug does not exist, or marks an existing article dirty for regeneration. Gated by the `wiki.enabled` feature flag.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `slug` | `string` | Yes | Target article slug |
| `title` | `string` | Yes | Article title (used when creating a new stub) |
| `kind` | `string` | Yes | Article kind (`topic / glossary / contradiction / procedure / safety`) |
| `dirty_reason` | `string (max 200)` | No | Reason for requesting regeneration |

#### Output

| Field | Type | Description |
|---|---|---|
| `article_id` | `string (uuid)` | Article row ID (new or existing) |
| `created` | `boolean` | True if a new stub was created |
| `dirty` | `boolean` | Always true after this call |

#### Behavior notes

- Feature-gated: calls `assertWikiEnabled(ctx)`.
- Uses `ON CONFLICT (slug) DO UPDATE SET dirty = true, dirty_reason = 'manual:re-requested'` — idempotent for existing articles.

---

### request_investigation

**File:** `request_investigation.ts` | **Annotation:** `readOnly: false`

Queues a compound or reaction for autonomous investigation. Inserts a row into `investigation_queue` at the highest priority (score = 1.0) with reason codes `['manual_request']`.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `subject` | `string` | Yes | The entity to investigate (e.g. SMILES, compound ID, reaction ID) |
| `subject_type` | `string` | Yes | Type of the subject (`compound / reaction / hypothesis / campaign`) |
| `reason` | `string (max 64)` | No | Short rationale (truncated to 64 chars if longer) |

#### Output

| Field | Type | Description |
|---|---|---|
| `queue_id` | `string (uuid)` | Inserted `investigation_queue` row ID |
| `subject` | `string` | Echoed subject |
| `score` | `number` | Always 1.0 for manual requests |

#### Behavior notes

- `reason` is truncated to 64 characters before insert.
- DB-enforced invariants in the INSERT policy prevent duplicate high-priority manual requests for the same subject within a short window.
- Persisted via `withUserContext`.

---

### retrieve_related

**File:** `retrieve_related.ts` | **Annotation:** `readOnly: true`

Performs hybrid retrieval combining knowledge graph facts and vector-indexed document/wiki chunks, fused via Reciprocal Rank Fusion (RRF). Calls `search_knowledge` and `query_kg` in parallel and merges the results.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `query` | `string` | Yes | Natural language query |
| `top_k` | `number (int 1–50)` | No | Number of results to return (default 10) |
| `include_wiki` | `boolean` | No | Include wiki article chunks in retrieval (default true) |
| `group_id` | `string` | No | KG group filter |

#### Output

| Field | Type | Description |
|---|---|---|
| `items` | `RetrievedItem[]` | RRF-fused results, sorted by descending score |
| `n_kg_facts` | `number (int)` | KG facts contributing to the fusion |
| `n_chunks` | `number (int)` | Document/wiki chunks contributing to the fusion |

Each `RetrievedItem` has `kind: "chunk" | "fact"`, a `score`, and the underlying fact or chunk data.

#### Behavior notes

- `armK` for each retrieval arm is `min(top_k × 2, 50)` to ensure the fusion has enough candidates.
- RRF constant: `RRF_K = 60` (standard).
- `include_wiki: true` is the default, implementing ADR 012 Phase 3c (wiki articles as first-class retrieval sources).

---

### run_chemspace_screen

**File:** `run_chemspace_screen.ts` | **Annotation:** `readOnly: false`

Enqueues a large-scale chemical space screening job. Resolves candidates from a SMILES list, SMARTS catalog match, or reaction class filter; creates a `chemspace_screens` row; and enqueues individual candidate tasks.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `screen_name` | `string (max 200)` | Yes | Human-readable screen identifier |
| `step_kind` | `"SP" \| "opt" \| "freq" \| "other"` | Yes | Computational step type for ETA estimation |
| `candidates` | `CandidateSource` | Yes | One of: `{ smiles_list }`, `{ smarts }`, or `{ reaction_class }` |
| `campaign_id` | `string (uuid)` | No | Link to a synthesis campaign |

#### Output

| Field | Type | Description |
|---|---|---|
| `screen_id` | `string (uuid)` | Inserted `chemspace_screens` row ID |
| `n_candidates` | `number (int)` | Number of candidates enqueued |
| `estimated_seconds` | `number` | ETA based on `n_candidates × step_time / concurrency` |

#### Behavior notes

- **ETA estimates per step kind:** `SP: 3 s`, `opt: 30 s`, `freq: 60 s`, `other: 5 s`, divided by concurrency of 4.
- SMARTS candidate resolution does a DB sample without an exact pre-filter (probabilistic, not exhaustive).
- Task queue operations use `createBatch` and `enqueueRows` from the task queue module.
- Persisted via `withUserContext`.

---

### run_orchestration_script

**File:** `run_orchestration_script.ts` | **Annotation:** `readOnly: false`

Executes a Monty Python orchestration script in a sandboxed environment. Scripts can call a curated subset of agent tools; a blocklist prevents re-entrant or dangerous invocations.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `script_name` | `string` | Yes | Registered script name in the Monty registry |
| `input` | `object` | No | Input parameters for the script |
| `timeout_s` | `number (int 1–300)` | No | Execution timeout in seconds (default 60) |

#### Output

| Field | Type | Description |
|---|---|---|
| `outcome` | `string` | One of: `ok / error / timeout / cancelled / child_crashed / preflight_denied / runtime_disabled` |
| `result` | `unknown` | Script return value on success |
| `error_message` | `string \| null` | Error detail on non-`ok` outcomes |
| `duration_ms` | `number` | Wall-clock duration |

#### Behavior notes

- **Three preflights before execution:**
  1. Script must exist in the Monty registry.
  2. `FORBIDDEN_TOOL_IDS` blocklist prevents scripts from calling `ask_user`, `enqueue_batch`, `workflow_*`, or `manage_todos`.
  3. Optional permission resolver gate.
- `MONTY_RUNNER_ALLOW_UNSAFE_EXEC=1` is refused in production unless `MCP_AUTH_DEV_MODE=true`.
- Gated by config key `monty.enabled`.
- OTel attributes are set on the active span for `script_name`, `outcome`, and `duration_ms`.

---

### run_program

**File:** `run_program.ts` | **Annotation:** `readOnly: false`

Executes Python code in an E2B cloud sandbox with a pre-injected stub library that exposes ChemClaw tools to the sandboxed environment. The sandbox is session-cached.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | `string` | Yes | Python code to execute |
| `timeout_s` | `number (int 1–120)` | No | Execution timeout (default 30 s) |
| `session_id` | `string` | No | Reuse an existing sandbox session |

#### Output

| Field | Type | Description |
|---|---|---|
| `stdout` | `string` | Standard output |
| `stderr` | `string` | Standard error |
| `output` | `unknown` | Structured output from the `__chemclaw_output__` JSON line convention |
| `exit_code` | `number (int)` | Process exit code |

#### Behavior notes

- **Stub library** (auto-injected): exposes `fetch_document`, `query_kg`, `find_similar_reactions`, `canonicalize_smiles`, `embed_text`, and `compute_drfp` as Python functions.
- **Output convention:** the last JSON line containing the key `__chemclaw_output__` is parsed as the structured output.
- Sandbox is acquired via `acquireSessionSandbox` (session-cached); a new E2B sandbox is created on cache miss.
- Exports: `buildStubLibrary`, `preflightCheck`, `parseOutputs`, `wrapCode`, `clearStubCache`.

---

### run_shell

**File:** `run_shell.ts` | **Annotation:** `readOnly: false`

Executes a shell command within the agent's sandboxed filesystem. Uses direct process `spawn` — no shell expansion.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `argv` | `string[] (min 1)` | Yes | Command and arguments as an array |
| `stdin` | `string` | No | Data to pipe to the process's stdin |
| `timeout_ms` | `number (int)` | No | Execution timeout (default 30,000 ms) |

#### Output

| Field | Type | Description |
|---|---|---|
| `stdout` | `string` | Standard output (truncated at 256 KiB) |
| `stderr` | `string` | Standard error (truncated at 256 KiB) |
| `exit_code` | `number (int)` | Process exit code |
| `stdout_discarded_bytes` | `number (int)` | Bytes dropped from stdout due to the cap |
| `stderr_discarded_bytes` | `number (int)` | Bytes dropped from stderr due to the cap |

#### Behavior notes

- `argv[0]` must not contain `/` or `\`; absolute paths and path traversal are rejected.
- Working directory is set to `AGENT_FS_ROOT`.
- Environment is stripped to `PATH`, `HOME`, and `LANG` only.
- Requires `AGENT_FS_TOOLS_ENABLED=true`; throws `fs_tools_disabled` otherwise.
- Default-disabled to prevent unintended filesystem side effects.

---

### score_green_chemistry

**File:** `score_green_chemistry.ts` | **Annotation:** `readOnly: true`

Scores solvents against multiple green chemistry frameworks: CHEM21, GSK, Pfizer, AZ, Sanofi, and ACS GCI-PR. Delegates to mcp-green-chemistry `/score_solvents`.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `solvents` | `string[] (min 1, max 50)` | Yes | Solvent names or SMILES to score |

#### Output

| Field | Type | Description |
|---|---|---|
| `scores` | `SolventScore[]` | Per-solvent scores across all frameworks |

Each `SolventScore` includes `solvent`, a `scores` object keyed by framework name, `recommended` (boolean), and `match_confidence` (indicating how reliably the solvent was identified).

#### Behavior notes

- Timeout: 10 s.
- `match_confidence` distinguishes exact name matches from fuzzy/synonym matches.

---

### screen_admet

**File:** `screen_admet.ts` | **No annotations specified**

> **Status: pending registration.** This tool file exists but is not yet wired into `dependencies.ts` and will not appear in the agent's live tool list. The backing `mcp-admetlab` service (port 8011) has also been removed from `docker-compose.yml`. Documented here for reference; do not call this tool in the current deployment.

Screens compounds for ADMET (Absorption, Distribution, Metabolism, Excretion, and Toxicity) properties using ADMETlab. Evaluates 119 endpoints across all five ADMET categories.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `smiles_list` | `string[] (min 1, max 50)` | Yes | SMILES to screen |
| `endpoints` | `string[]` | No | Subset of endpoint names to evaluate; omit for all 119 |

#### Output

| Field | Type | Description |
|---|---|---|
| `results` | `AdmetResult[]` | Per-compound ADMET profiles |

Each `AdmetResult` includes `smiles`, a `properties` map of endpoint name to predicted value, and `structural_alerts` listing any flagged substructures.

#### Behavior notes

- Delegates to mcp-admetlab `/screen`. Timeout: 90 s.
- Structural alerts are returned as a separate list from the numeric property predictions.

---

### search_knowledge

**File:** `search_knowledge.ts` | **Annotation:** `readOnly: true`

Performs hybrid dense + sparse knowledge retrieval over document chunks and optionally wiki article chunks. Uses BGE-M3 dense embeddings and pg_trgm sparse matching, fused via RRF.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `query` | `string` | Yes | Natural language search query |
| `top_k` | `number (int 1–50)` | No | Number of results (default 10) |
| `include_wiki` | `boolean` | No | Include `wiki_chunks` in retrieval (default true) |
| `filters` | `SearchFilters` | No | Optional document-type, project, or date filters |

#### Output

| Field | Type | Description |
|---|---|---|
| `hits` | `SearchHit[]` | Ranked results from the hybrid search |
| `query` | `string` | Echoed query |

Each `SearchHit` includes `kind: "document" | "wiki"`, `score`, `chunk_id` or `article_id`, `snippet`, and a `cite` object with `kind: "document_chunk" | "knowledge_article"`.

#### Behavior notes

- Runs up to four parallel retrieval arms in hybrid mode (dense document, sparse document, dense wiki, sparse wiki).
- RRF constant: `RRF_K = 60`.
- `include_wiki: true` is the default per ADR 012 Phase 3c.
- Exports `_rrfForTests` for unit test access to the fusion logic.

---

### simulate_chrom_retention

**File:** `simulate_chrom_retention.ts` | **Annotation:** `readOnly: true`

Simulates HPLC retention times using the LSS (Linear Solvent Strength) Snyder-Dolan model. Used to evaluate proposed gradient programs before physical experiments.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `column_id` | `string (uuid)` | Yes | Column to simulate on |
| `lss_by_analyte` | `LssParams[]` | No | Explicit LSS parameters per analyte (for initial simulation) |
| `scouting_observations` | `ScoutingObs[]` | No | Observed retention from scouting runs (for LSS fitting + refinement) |
| `gradient_program` | `GradientStep[]` | Yes | Proposed gradient to simulate |
| `flow_rate_ml_min` | `number` | Yes | Flow rate |

One of `lss_by_analyte` or `scouting_observations` is required.

#### Output

| Field | Type | Description |
|---|---|---|
| `peaks` | `SimulatedPeak[]` | Predicted retention times and peak widths per analyte |
| `crf` | `number` | Chromatographic Response Function (overall separation quality) |
| `min_resolution` | `number` | Minimum peak-to-peak resolution across all analyte pairs |
| `runtime_min` | `number` | Total predicted run time |
| `solvent_pmi_g` | `number` | Estimated solvent Process Mass Intensity in grams |

#### Behavior notes

- Delegates to mcp-chrom-method-optimizer `/simulate_retention`. Timeout: 30 s.

---

### start_chrom_campaign

**File:** `start_chrom_campaign.ts` | **Annotation:** `readOnly: false`

Initializes a Bayesian optimization campaign for chromatography method development. Builds a BoFire domain using Tanaka 6-axis column descriptors and inserts a new `optimization_campaigns` row.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `campaign_name` | `string (max 200)` | Yes | Human-readable campaign name |
| `analyte_smiles` | `string[]` | Yes | Target analytes to optimize separation for |
| `column_ids` | `string[] (uuid[])` | Yes | Column candidates to include in the search space |
| `eluent_mode` | `"binary" \| "ternary"` | No | Solvent system mode (default `binary`) |
| `objectives` | `ChromObjective[]` | Yes | Optimization objectives (e.g. maximize resolution, minimize runtime) |

#### Output

| Field | Type | Description |
|---|---|---|
| `campaign_id` | `string (uuid)` | Inserted `optimization_campaigns` row ID |
| `domain_summary` | `object` | Summary of the constructed BoFire domain |

#### Behavior notes

- Column Tanaka vectors are fetched via `query_chrom_columns` and encoded as `CategoricalDescriptorInput` for BoFire.
- Delegates domain construction to mcp-chrom-method-optimizer `/build_domain`. Timeout: 30 s.
- Persisted via `withUserContext`.

---

### start_optimization_campaign

**File:** `start_optimization_campaign.ts` | **Annotation:** `readOnly: false`

Initializes a Bayesian optimization campaign for reaction condition optimization. Builds a BoFire domain from continuous and categorical factor specifications and inserts an `optimization_campaigns` row.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `campaign_name` | `string (max 200)` | Yes | Human-readable campaign name |
| `factors` | `Factor[]` | Yes | Search space factors (continuous ranges or categorical options) |
| `objectives` | `Objective[]` | Yes | Optimization objectives with output bounds |
| `strategy` | `string` | No | BoFire strategy name (default `"SOBO"`) |
| `acquisition` | `string` | No | Acquisition function (default `"qNEI"`) |
| `synthesis_campaign_id` | `string (uuid)` | No | Link to a synthesis campaign |
| `seed` | `number (int)` | No | Random seed; generated via `crypto.randomInt` if omitted |

#### Output

| Field | Type | Description |
|---|---|---|
| `campaign_id` | `string (uuid)` | Inserted row ID |
| `bofire_domain` | `object` | The BoFire domain JSON that was stored |

#### Behavior notes

- `output_bounds` are validated: lower bound must be ≤ upper bound for each objective.
- `synthesis_campaign_id` is verified to exist under RLS if supplied.
- Domain construction delegates to mcp-reaction-optimizer `/build_domain`. Timeout: 30 s.

---

### start_synthesis_campaign

**File:** `start_synthesis_campaign.ts` | **Annotation:** `readOnly: false`

Creates a synthesis campaign umbrella record and seeds it with PLAYBOOK step definitions. Each step is linked to the previous via a `depends_on` chain, forming an ordered execution plan.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `campaign_name` | `string (max 200)` | Yes | Human-readable campaign name |
| `kind` | `"single_experiment" \| "library_synthesis" \| "screening" \| "bo_campaign" \| "bo_or_die"` | Yes | Campaign playbook type |
| `nce_project_id` | `string (uuid)` | Yes | Parent NCE project |
| `steps` | `StepSpec[]` | Yes | Ordered step definitions |
| `metadata` | `object` | No | Freeform campaign metadata |

#### Output

| Field | Type | Description |
|---|---|---|
| `campaign_id` | `string (uuid)` | Inserted `synthesis_campaigns` row ID |
| `total_steps` | `number (int)` | Count of seeded steps |
| `event_type` | `string` | Always `campaign_created` |

#### Behavior notes

- `depends_on` is set to the previous step's ID for each step in order, creating a linear dependency chain.
- `total_steps` is updated on the campaign row after all steps are inserted.
- Emits a `campaign_created` ingestion event.

---

### statistical_analyze

**File:** `statistical_analyze.ts` | **Annotation:** `readOnly: true` | **Result schema:** `predict_yield_for_similar.v1`

Runs statistical analysis on a set of reactions. Supports three question modes: SQL-only bucket aggregation, TabICL regression prediction, and TabICL permutation importance ranking.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `reaction_ids` | `string[] (uuid[], min 5, max 500)` | Yes | Support set of reactions |
| `question` | `"predict_yield_for_similar" \| "rank_feature_importance" \| "compare_conditions"` | Yes | Analysis mode |
| `query_reaction_ids` | `string[] (uuid[], max 100)` | No | Required for `predict_yield_for_similar` |

#### Output

| Field | Type | Description |
|---|---|---|
| `task` | `"regression"` | Always `regression` |
| `support_size` | `number (int)` | Number of support rows used after featurization |
| `predictions` | `YieldPrediction[]` | Per-query predictions (`predict_yield_for_similar` only) |
| `feature_importance` | `FeatureImportance[]` | Sorted importance list (`rank_feature_importance` only) |
| `condition_comparison` | `ConditionBucket[]` | Bucket statistics (`compare_conditions` only) |
| `caveats` | `string[]` | Warnings about skipped rows or data quality |

#### Behavior notes

- **`compare_conditions`** executes a pure SQL `width_bucket` aggregation on solvent × temperature bins. No ML call.
- **`predict_yield_for_similar`** and **`rank_feature_importance`** featurize reactions via mcp-tabicl `/tools/featurize`, then call `/tools/predict_and_rank`.
- Reaction data is read from the `reactions_current` view (excludes invalidated reactions) via `withUserContext`.
- Timeout: 60 s per mcp-tabicl call.

---

### substructure_search

**File:** `substructure_search.ts` | **Annotation:** `readOnly: true`

Two-stage substructure search: a broad DB sample followed by exact RDKit-semantics filtering via mcp-rdkit.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `smarts` | `string` | Yes | SMARTS query pattern |
| `limit` | `number (int 1–500)` | No | Maximum results to return (default 50) |

#### Output

| Field | Type | Description |
|---|---|---|
| `matches` | `SubstructureMatch[]` | Compounds matching the SMARTS query |
| `n_screened` | `number (int)` | Count of compounds evaluated in the RDKit pass |

Each `SubstructureMatch` includes `compound_id`, `smiles`, `inchikey`, and `atom_indices`.

#### Behavior notes

- **Stage 1:** `withSystemContext` DB sample up to `limit × 20` (capped at 5,000) candidate SMILES.
- **Stage 2:** mcp-rdkit `/tools/bulk_substructure_search` applies exact SMARTS matching against the candidates.
- Using a DB sample rather than full-table scan means very rare substructures may not appear; increase `limit` to improve recall.
- Timeout: 60 s for the mcp-rdkit call.

---

### synthesize_insights

**File:** `synthesize_insights.ts` | **Annotation:** `readOnly: true`

LLM-based synthesis of cross-reaction insights from a set of reaction IDs. Calls `expand_reaction_context` internally to gather context, then uses the `tool.synthesize_insights` prompt from the prompt registry to generate insights.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `reaction_ids` | `string[] (uuid[], min 1, max 100)` | Yes | Reactions to synthesize insights from |
| `focus` | `string` | No | Optional focus area (e.g. `"yield drivers"`, `"selectivity"`) |
| `max_insights` | `number (int 1–20)` | No | Maximum insights to return (default 5) |

#### Output

| Field | Type | Description |
|---|---|---|
| `insights` | `Insight[]` | Generated insights with supporting fact references |
| `fact_ids_used` | `string[] (uuid[])` | All KG fact IDs referenced across all insights |

Each `Insight` includes `text`, `confidence`, and `cited_fact_ids`.

#### Behavior notes

- **Anti-fabrication SOFT filter:** insights referencing fact IDs not in `ctx.scratchpad.seenFactIds` are logged at `warn` and dropped rather than throwing. The valid insights still return.
- `MAX_PARALLEL = 20` concurrent context-expansion calls via `boundedMap`.
- All referenced fact IDs are accumulated into `ctx.scratchpad.seenFactIds` after the call.
- System prompt read from `prompt_registry` key `"tool.synthesize_insights"`.

---

### update_hypothesis_status

**File:** `update_hypothesis_status.ts` | **Annotation:** `readOnly: false`

Updates the status of an existing hypothesis (e.g. marking it confirmed or refuted). Restricted to the hypothesis owner via the `hypotheses_owner_update` RLS policy.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `hypothesis_id` | `string (uuid)` | Yes | Hypothesis to update |
| `status` | `"active" \| "confirmed" \| "refuted" \| "superseded"` | Yes | New status |
| `notes` | `string (max 1000)` | No | Notes on the status change |

#### Output

| Field | Type | Description |
|---|---|---|
| `hypothesis_id` | `string (uuid)` | Echoed hypothesis ID |
| `previous_status` | `string` | Status before the update |
| `new_status` | `string` | Applied status |

#### Behavior notes

- `refuted_at` is stamped only when transitioning **to** `refuted` (not on re-confirmation).
- The DB trigger `trg_hypotheses_status_event` fires `hypothesis_status_changed` automatically on status change.
- Both a no-op (same status) and an RLS violation (wrong owner) throw the same error to avoid information leakage.

---

### update_synthesis_campaign_step

**File:** `update_synthesis_campaign_step.ts` | **Annotation:** `readOnly: false`

Records progress on an individual synthesis campaign step. Advances step status through `started → completed/skipped/cancelled/failed`; emits per-step lifecycle events; bumps the campaign `completed_steps` counter and `etag`.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `step_id` | `string (uuid)` | Yes | Step to update |
| `status` | `"started" \| "completed" \| "skipped" \| "cancelled" \| "failed"` | Yes | New step status |
| `outputs` | `object` | No | Structured outputs from the step |
| `notes` | `string (max 1000)` | No | Free-form notes |
| `external_ref` | `string (max 200)` | No | Reference to an external record (e.g. ELN entry ID) |

#### Output

| Field | Type | Description |
|---|---|---|
| `step_id` | `string (uuid)` | Echoed step ID |
| `campaign_id` | `string (uuid)` | Parent campaign ID |
| `event_type` | `string` | Emitted event type (e.g. `step_completed`) |
| `completed_steps` | `number (int)` | Updated count on the campaign |
| `campaign_etag` | `number (int)` | New campaign etag |

#### Behavior notes

- **Idempotency guard:** re-completing a step that is already in a terminal status updates `outputs`/`notes`/`external_ref` but does not increment `completed_steps` again.
- A `step_added` event is emitted when the step transitions from a null status to `started` for the first time.

---

### upsert_article

**File:** `upsert_article.ts` | **Annotation:** `readOnly: false`

Creates or updates a knowledge wiki article. Restricted to agent-authorable kinds (`topic`, `glossary`, `contradiction`). Saves a revision snapshot for every write. Gated by the `wiki.enabled` feature flag.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `slug` | `string` | Yes | Article slug (must be URL-safe) |
| `title` | `string (max 200)` | Yes | Article title |
| `kind` | `"topic" \| "glossary" \| "contradiction"` | Yes | Article kind |
| `body_md` | `string` | Yes | Article body in Markdown |
| `cited_fact_ids` | `string[] (uuid[])` | No | KG fact IDs to link as citations |
| `cited_chunk_ids` | `string[]` | No | Document chunk IDs to link as citations |
| `cited_experiment_ids` | `string[] (uuid[])` | No | Experiment IDs to link as citations |

#### Output

| Field | Type | Description |
|---|---|---|
| `article_id` | `string (uuid)` | Article row ID |
| `revision` | `number (int)` | New revision number |
| `slug` | `string` | Confirmed slug |

#### Behavior notes

- Feature-gated: calls `assertWikiEnabled(ctx)`.
- **Human-edit block:** `containsHumanBlock()` checks the body for `<!-- human:begin -->` markers (ADR 012). If found, the call throws rather than overwriting human-curated content.
- **Human-edit protection:** the `ON CONFLICT (slug) DO UPDATE` clause includes `WHERE knowledge_articles.has_human_edits = false` — articles with human edits are silently not overwritten.
- Inline citations are parsed from `[fact:<uuid>]`, `[chunk:<id>]`, `[experiment:<id>]`, and `[article:<slug>]` patterns in the body.
- A snapshot is saved to `knowledge_article_revisions` on every upsert.

---

### workflow_define

**File:** `workflow_define.ts` | **Annotation:** `readOnly: false`

Defines or redefines a named workflow. Each call creates a new bi-temporal version. The definition is validated against the workflow DSL schema.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Workflow name (unique within scope) |
| `definition` | `object` | Yes | Workflow DSL definition (max 256 KB serialized) |
| `description` | `string` | No | Human-readable description |
| `scope` | `"private" \| "project" \| "org" \| "global"` | No | Visibility scope (default `private`) |

#### Output

| Field | Type | Description |
|---|---|---|
| `workflow_id` | `string (uuid)` | New `workflows` row ID |
| `version` | `number (int)` | Version number (incremented on each call) |
| `name` | `string` | Confirmed workflow name |

#### Behavior notes

- Calls `defineWorkflow()` from the workflow DSL module.
- Audited via `appendAudit` with action `workflow.define`.
- Maximum definition size: 256 KB.

---

### workflow_inspect

**File:** `workflow_inspect.ts` | **Annotation:** `readOnly: true`

Returns the current state of a workflow run, including the run row, state cursor, and a window of recent events.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `run_id` | `string (uuid)` | Yes | Workflow run to inspect |
| `last_n_events` | `number (int 1–500)` | No | Number of recent events to include (default 50) |

#### Output

| Field | Type | Description |
|---|---|---|
| `run` | `WorkflowRun` | Run row (id, status, created_at, etc.) |
| `state` | `WorkflowState` | Current step index, scope, and execution cursor |
| `events` | `WorkflowEvent[]` | Last `last_n_events` events for the run |

#### Behavior notes

- Calls `inspectRun()` from the workflow engine module.

---

### workflow_modify

**File:** `workflow_modify.ts` | **Annotation:** `readOnly: false`

Modifies the workflow definition for a **paused** run in-place. Records the before/after states for auditability. Produces a new bi-temporal version of the workflow.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `run_id` | `string (uuid)` | Yes | Paused run to modify |
| `new_definition` | `object` | Yes | Updated workflow DSL (max 256 KB) |
| `reason` | `string` | No | Reason for the in-flight modification |

#### Output

| Field | Type | Description |
|---|---|---|
| `run_id` | `string (uuid)` | Echoed run ID |
| `new_workflow_version` | `number (int)` | New version number |
| `modification_id` | `string (uuid)` | `workflow_modifications` row ID |

#### Behavior notes

- Throws `run_not_paused` if the run is not in `paused` status.
- Calls `modifyDefinition()` which records before/after in `workflow_modifications` + `workflow_events`.
- Audited via `appendAudit` with action `workflow.modify`.

---

### workflow_pause_resume

**File:** `workflow_pause_resume.ts` | **Annotation:** `readOnly: false`

Pauses or resumes a workflow run.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `run_id` | `string (uuid)` | Yes | Run to pause or resume |
| `action` | `"pause" \| "resume"` | Yes | Operation to perform |
| `reason` | `string` | No | Optional note |

#### Output

| Field | Type | Description |
|---|---|---|
| `run_id` | `string (uuid)` | Echoed run ID |
| `new_status` | `string` | `paused` or `running` |

#### Behavior notes

- `pause` calls `pauseRun()`; `resume` calls `resumeRun()`.
- Audited via `appendAudit`.

---

### workflow_replay

**File:** `workflow_replay.ts` | **Annotation:** `readOnly: false`

Creates a new workflow run by replaying an existing run, optionally with an overridden input. Useful for re-running a failed run with corrected parameters.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `run_id` | `string (uuid)` | Yes | Parent run to replay |
| `input_override` | `object` | No | Replacement input; defaults to the parent run's original input |

#### Output

| Field | Type | Description |
|---|---|---|
| `new_run_id` | `string (uuid)` | New run ID |
| `parent_run_id` | `string (uuid)` | Source run ID (for lineage tracking) |
| `status` | `string` | Always `running` immediately after creation |

#### Behavior notes

- Calls `replayRun()` which sets `parent_run_id` on the new run for lineage tracking.
- Audited via `appendAudit` with action `workflow.replay`.

---

### workflow_run

**File:** `workflow_run.ts` | **Annotation:** `readOnly: false`

Starts a workflow run asynchronously. Returns immediately with the new `run_id`; the engine executes the workflow in the background. Poll status via `workflow_inspect`.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `workflow_name` | `string` | Yes | Name of the workflow to run |
| `input` | `object` | No | Input parameters for the workflow |
| `session_id` | `string (uuid)` | No | Agent session to associate with the run |

#### Output

| Field | Type | Description |
|---|---|---|
| `run_id` | `string (uuid)` | New run ID |
| `status` | `string` | Always `running` at creation time |
| `workflow_name` | `string` | Confirmed workflow name |

#### Behavior notes

- Calls `startRun()` which enqueues the workflow for async execution.
- Audited via `appendAudit` with action `workflow.run`.

---

### write_file

**File:** `write_file.ts` | **Annotation:** `readOnly: false`

Writes content to a file within the agent's sandboxed filesystem (`AGENT_FS_ROOT`).

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | File path (resolved relative to `AGENT_FS_ROOT`) |
| `content` | `string` | Yes | Content to write (max 4 MiB) |
| `overwrite` | `boolean` | No | Allow overwriting an existing file (default false) |
| `create_parents` | `boolean` | No | Create parent directories if they do not exist (default false) |

#### Output

| Field | Type | Description |
|---|---|---|
| `path` | `string` | Absolute path of the written file |
| `size_bytes` | `number (int)` | Bytes written |
| `created` | `boolean` | True if the file was newly created; false if overwritten |

#### Behavior notes

- Path is validated via `resolveAndCheckPath`, rejecting traversal outside `AGENT_FS_ROOT`.
- When `overwrite=false` (the default), the tool checks for file existence via a stat probe and throws `file_exists` if the file already exists.
- When `create_parents=false` (the default), the tool throws if the parent directory does not exist.
- Content size cap: 4 MiB.
- Requires `AGENT_FS_TOOLS_ENABLED=true`.

---

### fetch_lims_result

**File:** `fetch_lims_result.ts` | **No annotations specified**

> **Status: pending registration.** This tool file exists but is not yet wired into `dependencies.ts` and will not appear in the agent's live tool list. It is documented here for completeness; it becomes active once registered.

Fetches a single STARLIMS test result by its unique ID. Uses the native `fetch` API with a 20-second abort timeout and builds a structured citation for the returned record.

#### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `result_id` | `string` | Yes | LIMS test result identifier |

#### Output

| Field | Type | Description |
|---|---|---|
| `result_id` | `string` | Echoed result ID |
| `sample_id` | `string` | Associated sample ID |
| `test_name` | `string` | Name of the analytical test |
| `analysis_name` | `string \| null` | Analysis name, if provided by the LIMS record |
| `value` | `unknown` | Test result value |
| `units` | `string \| null` | Units for the result value |
| `status` | `string` | Result status (e.g. `"approved"`, `"pending"`) |
| `measured_at` | `string (ISO 8601)` | Measurement timestamp |
| `citation` | `Citation` | Structured citation with `source_kind: "external_url"` |
| `snippet` | `string` | Brief human-readable summary including `analysis_name` when present |

#### Behavior notes

- HTTP 404 from the LIMS endpoint surfaces as a tool error with the response body included as `detail` — the agent can report the specific LIMS error message.
- Citation `source_kind` is always `"external_url"`.
- Timeout: 20 s (via `AbortSignal.timeout(20000)`).
