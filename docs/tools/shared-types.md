# ChemClaw Shared Type Schemas

Common Zod schemas reused across multiple builtin tools. Understanding these types helps interpret tool input/output documentation.

---

## ELN Shared Types (`_eln_shared.ts`)

### `ELN_ID_PATTERN`
Regex: `/^[A-Za-z0-9_.:-]+$/` — used to validate ELN identifiers (entry IDs, sample IDs, reaction IDs). Max 128 chars. Used in all ELN fetch/query tools.

### `ElnEntrySchema`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Entry ID |
| `notebook_id` | `string` | Parent notebook ID |
| `project_id` | `string` | NCE project ID |
| `project_code` | `string \| null` | Project code (e.g., `"NCE-1042"`) |
| `reaction_id` | `string \| null` | Reaction reference ID |
| `schema_kind` | `string` | Entry schema type (e.g., `"synthesis"`, `"analysis"`) |
| `title` | `string` | Entry title |
| `author_email` | `string \| null` | Author's email |
| `signed_by` | `string \| null` | Signature email |
| `status` | `string` | Entry status |
| `entry_shape` | `string` | Shape discriminant |
| `data_quality_tier` | `string` | Quality classification |
| `fields_jsonb` | `Record<string, unknown>` | Structured fields (yield, temp, solvents, etc.) |
| `freetext` | `string \| null` | Free-text procedure notes |
| `freetext_length_chars` | `integer` | Length of free-text |
| `created_at` | `string` | ISO 8601 creation timestamp |
| `modified_at` | `string` | ISO 8601 modification timestamp |
| `signed_at` | `string \| null` | ISO 8601 signing timestamp |
| `citation_uri` | `string` | Canonical citation URI |
| `valid_until` | `string` | Bi-temporal validity end |

### `ElnSampleSchema`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Sample ID |
| `entry_id` | `string` | Parent entry ID |
| `inchikey` | `string \| null` | Compound InChIKey |
| `smiles` | `string \| null` | Compound SMILES |
| `name` | `string \| null` | Sample name |
| `purity_pct` | `number \| null` | Purity percentage |
| `amount_mg` | `number \| null` | Amount in milligrams |
| `results` | `SampleResult[]` | Array of analytical results |

### `CanonicalReactionSchema`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Canonical reaction ID |
| `rxn_smiles` | `string` | Reaction SMILES |
| `mean_yield` | `number \| null` | Mean yield across all ELN runs |
| `std_yield` | `number \| null` | Std deviation of yield |
| `ofat_count` | `integer` | Number of one-factor-at-a-time child entries |
| `ofat_children` | `ElnEntry[]` | Child ELN entries |
| `created_at` | `string` | ISO 8601 creation timestamp |

---

## QM Shared Types (`_qm_base.ts`)

### `QmMethodEnum`

Allowed values for the `method` field across all `qm_*` tools:

| Value | Description |
|---|---|
| `"GFN0"` | Geometry, Frequency, Noncovalent interactions (0th generation, no charge) |
| `"GFN1"` | GFN1-xTB (faster, good for geometries) |
| `"GFN2"` | **Default.** GFN2-xTB (best accuracy/speed trade-off for drug-like molecules) |
| `"GFN-FF"` | Force-field parameterized from GFN2. Fast, for large molecules / conformers. No electronic properties. |
| `"g-xTB"` | Next-generation xTB (extended basis, better for challenging geometries) |
| `"sTDA-xTB"` | Simplified time-dependent DFT for excitation energies |
| `"IPEA-xTB"` | Ionization potential / electron affinity xTB for redox potential calculations |

### `SolventModelEnum`

| Value | Description |
|---|---|
| `"none"` | **Default.** Gas-phase calculation |
| `"alpb"` | Analytical Linearized Poisson-Boltzmann. Recommended for polar solvents and redox calculations. |
| `"gbsa"` | Generalized Born with Surface Area. Faster but less accurate than ALPB. |
| `"cpcmx"` | Conductor-like polarizable continuum model (extended). Highest accuracy for solvation. |

### `QmRequestBase` fields (all `qm_*` tools extend this)

| Parameter | Type | Default | Description |
|---|---|---|---|
| `smiles` | `string` | required | Input SMILES (1–10000 chars) |
| `method` | `QmMethodEnum` | `"GFN2"` | xTB method |
| `charge` | `integer` | `0` | Formal molecular charge |
| `multiplicity` | `integer` | `1` | Spin multiplicity (1 = singlet, 2 = doublet, 3 = triplet) |
| `solvent_model` | `SolventModelEnum` | `"none"` | Implicit solvent model |
| `solvent_name` | `string` | — | Solvent identifier (e.g., `"water"`, `"acetonitrile"`, `"dmso"`, `"thf"`) |
| `force_recompute` | `boolean` | `false` | Bypass QM cache and force fresh run |

### `QmResponseBase` fields (all `qm_*` tools include these)

| Field | Type | Description |
|---|---|---|
| `job_id` | `string \| null` | UUID of the `qm_jobs` row; used by `qm_kg` projector |
| `cache_hit` | `boolean` | `true` = served from cache (< 100 ms); `false` = fresh computation |
| `status` | `string` | `"succeeded"`, `"failed"`, or `"running"` |
| `summary` | `string` | Human-readable result summary |
| `method` | `string` | Method actually used |
| `task` | `string` | Task type: `"single_point"`, `"geometry_opt"`, `"frequencies"`, etc. |

---

## Synthesis Campaign Shared Types (`_synthesis_shared.ts`)

### `CampaignKind`

| Value | Use Case |
|---|---|
| `"single_experiment"` | One-target synthesis with retrosynthesis and conditions |
| `"library_synthesis"` | N analogues from a scaffold (R-group library) |
| `"screening"` | HTE plate screen of one reaction at variable conditions |
| `"bo_campaign"` | Bayesian optimization — open-ended (no death gate) |
| `"bo_or_die"` | Bayesian optimization with hard budget cap; campaign fails if no improvement |

### `CampaignStatus`

| Value | Meaning |
|---|---|
| `"proposed"` | Just created; playbook steps seeded |
| `"active"` | Currently executing steps |
| `"awaiting_measurement"` | Blocked waiting for experimental data |
| `"paused"` | Agent explicitly paused |
| `"completed"` | All steps done |
| `"aborted"` | Manually stopped |
| `"failed"` | Step failure propagated to campaign level |
| `"died"` | BO-or-die budget exhausted with no improvement |

### `StepKind`

| Value | Description |
|---|---|
| `"retrosynthesis"` | Run retrosynthesis tools for the target |
| `"literature_pull"` | Search knowledge base and KG for precedent |
| `"condition_design"` | Recommend reaction conditions |
| `"library_design"` | Generate focused compound library |
| `"hte_plate_design"` | Design HTE plate layout |
| `"bo_round"` | One BO iteration (recommend + await + ingest) |
| `"forward_prediction"` | Forward reaction yield prediction |
| `"qm_screen"` | QM property screening of candidate compounds |
| `"mechanism_check"` | Mechanism elucidation and contradiction check |
| `"feasibility_assessment"` | `pharma-process-readiness` assessment |
| `"submit_batch"` | Submit batch to synthesis queue |
| `"measurement_wait"` | Wait for experimental results |
| `"ingest_results"` | Process and ingest experimental data |
| `"readiness_gate"` | Decision gate: scale-up / pilot / exploratory |
| `"die_check"` | BO-or-die budget check |
| `"summary"` | Generate campaign summary report |

### `StepStatus`

| Value | Meaning |
|---|---|
| `"pending"` | Not yet started |
| `"in_progress"` | Currently executing |
| `"completed"` | Successfully finished |
| `"skipped"` | Bypassed (pre-condition already met) |
| `"failed"` | Error during execution |
| `"cancelled"` | Cancelled before starting |

### `CampaignSummary` (returned by campaign tools)

| Field | Type | Description |
|---|---|---|
| `id` | `string (UUID)` | Campaign ID |
| `nce_project_id` | `string` | Parent NCE project UUID |
| `agent_session_id` | `string \| null` | Session that created this campaign |
| `kind` | `CampaignKind` | Campaign type |
| `name` | `string` | Campaign name |
| `status` | `CampaignStatus` | Current status |
| `goal` | `Record<string, unknown>` | Goal definition JSON |
| `policy` | `Record<string, unknown>` | Policy constraints JSON |
| `total_steps` | `integer` | Total steps in campaign |
| `completed_steps` | `integer` | Completed step count |
| `outcome_summary` | `string \| null` | Final outcome description |
| `created_at` | `string` | ISO 8601 creation timestamp |
| `updated_at` | `string` | ISO 8601 last update timestamp |
| `etag` | `string` | Optimistic concurrency ETag |

---

## Wiki Shared Types (`_wiki_shared.ts`)

### `ArticleKind`

| Value | Authoring | Description |
|---|---|---|
| `"compound"` | Projector only | Auto-generated per InChIKey |
| `"reaction_family"` | Projector only | Auto-generated per reaction class |
| `"nce_project"` | Projector only | Auto-generated per NCE project |
| `"synthesis_campaign"` | Projector only | Auto-generated per campaign |
| `"document_digest"` | Projector only | Digest of an indexed document |
| `"researcher"` | Projector only | Researcher profile |
| `"topic"` | **Agent-authorable** | Conceptual topics, methodologies |
| `"glossary"` | **Agent-authorable** | Term definitions |
| `"contradiction"` | **Agent-authorable** | Documented contradictions between sources |
| `"index"` | Projector only | Catalog index pages |
| `"log"` | Projector only | Activity logs |

### `Maturity` (used across `skill_library`, `hypotheses`, `artifacts`)

| Value | Meaning |
|---|---|
| `"EXPLORATORY"` | Initial, unvalidated (default) |
| `"WORKING"` | Validated at lab scale or with multiple observations |
| `"FOUNDATION"` | Peer-reviewed, multi-lab, or production-validated |

The `foundation-citation-guard` hook enforces that tools declaring `maturity_tier: "FOUNDATION"` must cite only `WORKING` or `FOUNDATION`-tier artifacts — not `EXPLORATORY` ones.

---

## Confidence Tiers (Knowledge Graph)

Used in `query_kg` output and `promote_to_kg` input:

| Tier | Description |
|---|---|
| `"expert_validated"` | Human expert explicitly validated |
| `"multi_source_llm"` | Corroborated by ≥ 2 independent LLM extractions |
| `"single_source_llm"` | Extracted by LLM from a single source |
| `"expert_disputed"` | Human expert flagged as questionable |
| `"invalidated"` | Fact has been retracted |

---

## Feature Flags Relevant to Tools

| Flag | Default | Controls |
|---|---|---|
| `wiki.enabled` | `false` | All knowledge-wiki builtins (`read_article`, `list_articles`, `upsert_article`, `request_article`) |
| `kg.auto_extraction.enabled` | `false` | `tool-invocation-emitter` hook + `tool_result_extractor` projector |
| `kg.conclusion_extraction.enabled` | `false` | `kg-conclusion-buffer` + `kg-conclusion-extractor` hooks |
| `chemistry.compute_results.persist` | `false` | `compute-result-writer` hook |
| `agent.confidence_cross_model` | `false` | Cross-model confidence scoring |

Enable flags via: `PATCH /api/admin/feature-flags/<flag-key>`
