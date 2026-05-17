# ChemClaw MCP Services Reference

All MCP services are built on `create_app()` from `services.mcp_tools.common.app`, which provides:
- `GET /healthz` — liveness probe (always 200)
- `GET /readyz` — readiness probe (service-specific checks)
- Request-ID middleware (logs `x-request-id` for every call)
- `ValueError → HTTP 400` automatic mapping
- Bearer token authentication (HS256 JWT, signed with `MCP_AUTH_SIGNING_KEY`)

**Dev mode:** Set `MCP_AUTH_DEV_MODE=true` to bypass token validation (not for production). Test suite sets this automatically via `pytest` conftest.

**SMILES validation:** All endpoints validate SMILES via RDKit before doing work. Invalid SMILES return HTTP 400 with a `reason` field.

**Batch limits:** `MAX_BATCH_SMILES = 100` (per-service limit on list inputs), `MAX_SMILES_LEN = 5000` (per-SMILES character limit), `MAX_RXN_SMILES_LEN = 10000`.

---

All MCP services are built on `create_app()` from `services.mcp_tools.common.app`, which provides `/healthz`, `/readyz`, request-ID middleware, and automatic `ValueError → 400` mapping. All endpoints require Bearer token authentication with a service-specific scope. Invalid SMILES return HTTP 400 with a specific error reason.

---

### `mcp-rdkit` (port default via `ToolSettings`)

RDKit cheminformatics as a stateless tool service.

**`POST /tools/canonicalize_smiles`**

Canonicalizes SMILES and returns chemical metadata.

Request (`CanonicalizeIn`):

| Field | Type | Constraints | Description |
|---|---|---|---|
| `smiles` | `string` | 1–`MAX_SMILES_LEN` | Input SMILES |
| `kekulize` | `bool` | default `false` | Return Kekulé form |

Response (`CanonicalizeOut`):

| Field | Type | Description |
|---|---|---|
| `canonical_smiles` | `string` | RDKit-canonical SMILES |
| `inchikey` | `string` | Standard InChIKey (27 chars) |
| `formula` | `string` | Molecular formula (e.g., `C9H8O4`) |
| `mw` | `float` | Molecular weight (Da) |

---

**`POST /tools/inchikey_from_smiles`**

Returns the InChIKey for a SMILES string.

Request (`InchikeyIn`): `smiles` (string, 1–`MAX_SMILES_LEN`)

Response (`InchikeyOut`): `inchikey` (string)

---

**`POST /tools/morgan_fingerprint`**

Computes an extended-connectivity (Morgan/ECFP) fingerprint.

Request (`MorganIn`):

| Field | Type | Constraints | Default |
|---|---|---|---|
| `smiles` | `string` | 1–`MAX_SMILES_LEN` | — |
| `radius` | `int` | 1–4 | `2` |
| `n_bits` | `int` | 512–4096 | `2048` |

Response (`MorganOut`): `n_bits` (int), `on_bits` (list[int] — indices of set bits)

---

**`POST /tools/compute_descriptors`**

Computes RDKit 2D molecular descriptors.

Request (`DescriptorsIn`):

| Field | Type | Description |
|---|---|---|
| `smiles` | `string` | Input SMILES |
| `which` | `list[DescriptorKey] \| null` | Subset to compute; `null` = all 12 |

Available descriptor keys: `mw`, `logp`, `tpsa`, `hbd`, `hba`, `rotatable_bonds`, `heavy_atom_count`, `aromatic_ring_count`, `ring_count`, `fsp3`, `qed`, `formal_charge`.

Response (`DescriptorsOut`): `values` (dict[str, float])

---

**`POST /tools/maccs_fingerprint`**

Returns the 167-bit MACCS structural keys fingerprint.

Request: `smiles` (string) | Response (`MaccsOut`): `n_bits: 167`, `on_bits` (list[int])

---

**`POST /tools/atompair_fingerprint`**

Computes a topological atom-pair fingerprint.

Request (`AtomPairIn`): `smiles` (string), `n_bits` (int, 512–4096, default 2048)

Response (`AtomPairOut`): `n_bits` (int), `on_bits` (list[int])

---

**`POST /tools/substructure_match`**

SMARTS substructure query against a single SMILES target.

Request (`SubstructureMatchIn`):

| Field | Type | Constraints | Default |
|---|---|---|---|
| `query_smarts` | `string` | 1–500 chars | — |
| `target_smiles` | `string` | 1–`MAX_SMILES_LEN` | — |
| `use_chirality` | `bool` | — | `false` |

Response (`SubstructureMatchOut`): `matches` (list[list[int]] — atom indices per match), `count` (int)

Error: HTTP 400 if SMARTS is invalid.

---

**`POST /tools/bulk_substructure_search`**

SMARTS substructure query against a candidate list. Does not query the canonical compounds table directly — agents pre-filter by fingerprint and pass candidates here for re-verification.

Request (`BulkSubstructureSearchIn`):

| Field | Type | Constraints | Description |
|---|---|---|---|
| `query_smarts` | `string` | 1–500 chars | SMARTS query |
| `candidates` | `list[{inchikey, smiles}]` | — | Pre-filtered candidates |
| `limit` | `int` | 1–5000, default 200 | Maximum candidates to scan |

Response (`BulkSubstructureSearchOut`): `hits` (list[{inchikey, smiles, n_matches}]), `n_scanned` (int)

---

**`POST /tools/murcko_scaffold`**

Extracts the Murcko scaffold (framework) from a molecule.

Request: `smiles` (string) | Response (`ScaffoldOut`): `scaffold_smiles` (string|null), `scaffold_inchikey` (string|null). Returns null fields for acyclic molecules.

---

### `mcp-drfp` (port default via `ToolSettings`)

Differential Reaction Fingerprint (DRFP) service. Data-independent, deterministic 2048-bit binary fingerprint from reaction SMILES (Probst et al., *Digital Discovery* 2022, MIT license).

**`POST /tools/compute_drfp`**

Request (`ComputeDrfpIn`):

| Field | Type | Constraints | Default | Description |
|---|---|---|---|---|
| `rxn_smiles` | `string` | 3–`MAX_RXN_SMILES_LEN`, must contain `>` | — | Reaction SMILES (`reagents>>products` or `reagents>catalysts>products`) |
| `n_folded_length` | `int` | 512–4096 | `2048` | Fingerprint bit length |
| `radius` | `int` | 1–5 | `3` | N-gram radius |

Response (`ComputeDrfpOut`):

| Field | Type | Description |
|---|---|---|
| `n_bits` | `int` | Fingerprint length |
| `vector` | `list[int]` | Full binary vector (0/1 per bit) |
| `on_bit_count` | `int` | Number of set bits |

Errors: HTTP 400 if SMILES lacks `>` separator or if DRFP encoding fails.

---

### `mcp-chemprop` (port 8009)

Chemprop v2 MPNN yield and molecular property prediction. Pretrained models loaded from `CHEMPROP_MODEL_DIR` (default `/var/lib/mcp-chemprop/models/`). `/readyz` returns 503 if the model directory is missing.

**`POST /predict_yield`**

Reaction yield prediction with uncertainty quantification.

Request (`PredictYieldIn`):

| Field | Type | Constraints |
|---|---|---|
| `rxn_smiles_list` | `list[string]` | 1–`MAX_BATCH_SMILES` elements; each element max `MAX_SMILES_LEN` chars |

Response (`PredictYieldOut`): `predictions` (list[`YieldPrediction`])

`YieldPrediction`: `rxn_smiles` (string), `predicted_yield` (float, %), `std` (float, %), `model_id` (string, e.g., `"yield_model@v1"`)

---

**`POST /predict_property`**

Molecular property prediction.

Request (`PredictPropertyIn`):

| Field | Type | Constraints |
|---|---|---|
| `smiles_list` | `list[string]` | 1–`MAX_BATCH_SMILES` elements |
| `property` | `"logP" \| "logS" \| "mp" \| "bp"` | — |

Response (`PredictPropertyOut`): `predictions` (list[`PropertyPrediction`])

`PropertyPrediction`: `smiles` (string), `value` (float), `std` (float)

---

### `mcp-kg` (port default via `KGSettings`)

Knowledge-graph service backed by Neo4j Community Edition. Manages bi-temporal, confidence-scored fact edges with required provenance. `/readyz` performs an async Neo4j reachability check.

**`POST /tools/write_fact`**

Create a new fact edge, or create-and-link nodes when they don't exist.

Request (`WriteFactRequest`):

| Field | Type | Constraints | Description |
|---|---|---|---|
| `subject` | `EntityRef` | — | Subject node reference |
| `object` | `EntityRef` | — | Object node reference |
| `predicate` | `PredicateStr` | `^[A-Z][A-Z0-9_]*$`, max 80 chars | Edge predicate |
| `group_id` | `GroupIdStr` | `^[A-Za-z0-9_\-]+$`, max 80 | Tenant scope (default: `__system__`) |
| `subject_properties` | `dict[str, scalar] \| null` | Keys max 80 chars; values scalar only | Extra node properties (CREATE only) |
| `object_properties` | `dict[str, scalar] \| null` | Same as above | Extra node properties (CREATE only) |
| `edge_properties` | `dict[str, scalar] \| null` | Same as above | Extra edge properties |
| `confidence_tier` | `ConfidenceTier` | enum | Default: `single_source_llm` |
| `confidence_score` | `float` | 0.0–1.0 | Default: `0.5` |
| `t_valid_from` | `datetime \| null` | timezone-aware | Defaults to server time |
| `provenance` | `Provenance` | required | Traceability record |
| `fact_id` | `UUID \| null` | — | Idempotency key; no-op if already present |

`EntityRef`: `{label: LabelStr, id_property: ^[a-z_]+$ max 40, id_value: SafeStr max 4000}`

`Provenance`: `{source_type, source_id, extracted_by_agent_run_id?, extractor_model_version?, extraction_prompt_version?}` where `source_type` ∈ `{ELN, SOP, literature, analytical, user_correction, agent_inference, import_tool}`

`ConfidenceTier` values: `expert_validated`, `multi_source_llm`, `single_source_llm`, `expert_disputed`, `invalidated`

Response (`WriteFactResponse`): `fact_id` (UUID), `created` (bool — false if idempotency key already existed), `t_valid_from` (datetime), `recorded_at` (datetime)

---

**`POST /tools/invalidate_fact`**

Mark a fact as invalid (soft-delete via temporal columns).

Request (`InvalidateFactRequest`):

| Field | Type | Description |
|---|---|---|
| `fact_id` | `UUID` | The fact to invalidate |
| `reason` | `SafeStr` | Human-readable invalidation reason |
| `invalidated_by_provenance` | `Provenance` | Who/what initiated the invalidation |
| `t_valid_to` | `datetime \| null` | Effective invalidation time; defaults to now |
| `new_confidence_tier` | `ConfidenceTier` | Default: `invalidated` |
| `group_id` | `GroupIdStr` | Tenant scope; cross-tenant invalidation is denied |

Response (`InvalidateFactResponse`): `fact_id` (UUID), `invalidated_at` (datetime), `was_already_invalid` (bool)

Error: HTTP 404 when `fact_id` not found or cross-tenant mismatch.

---

**`POST /tools/query_at_time`**

Retrieve all fact edges touching an entity at a given point in time (bi-temporal query).

Request (`QueryAtTimeRequest`):

| Field | Type | Default | Description |
|---|---|---|---|
| `entity` | `EntityRef` | — | The entity to traverse |
| `predicate` | `PredicateStr \| null` | `null` = all | Filter to a specific predicate |
| `direction` | `"out" \| "in" \| "both"` | `"both"` | Edge direction |
| `at_time` | `datetime \| null` | `null` = now | Point in time for the query |
| `include_invalidated` | `bool` | `false` | Include invalidated edges |
| `group_id` | `GroupIdStr` | `__system__` | Tenant scope filter |

Response (`QueryAtTimeResponse`): `facts` (list[`QueriedFact`])

`QueriedFact` includes: `fact_id`, `subject`, `predicate`, `object`, `edge_properties`, `confidence_tier`, `confidence_score`, `t_valid_from`, `t_valid_to`, `recorded_at`, `provenance`.

---

**`POST /tools/get_fact_provenance`**

Return the full provenance and bi-temporal envelope for a `fact_id`. Used by the agent to answer "why am I seeing this fact?"

Request (`GetFactProvenanceRequest`): `fact_id` (UUID), `group_id` (GroupIdStr, default `__system__`)

Response (`GetFactProvenanceResponse`): all fields from `QueriedFact` plus `invalidated_at` (datetime|null) and `invalidation_reason` (string|null).

Error: HTTP 404 when `fact_id` not found or cross-tenant mismatch.

---

### `mcp-xtb` (port default via `ToolSettings`)

Full xTB / g-xTB / sTDA-xTB / IPEA-xTB quantum chemistry capability surface. All results are cached in `qm_jobs` (keyed by SHA-256 of method + task + canonical SMILES + params). The `qm_kg` projector picks up new rows and creates Neo4j calculation nodes. SMILES inputs are validated by RDKit before invoking the xTB subprocess. All subprocesses use `shell=False` with an explicit argument list.

**Base request shape (`QmReqBase`):**

| Field | Type | Default | Description |
|---|---|---|---|
| `smiles` | `string` | required | Input SMILES |
| `method` | `QmMethod` | `"GFN2"` | `"GFN2"`, `"GFN1"`, `"GFN-FF"`, `"g-xTB"` |
| `charge` | `int` | `0` | Molecular charge |
| `multiplicity` | `int` | `1` | Spin multiplicity |
| `solvent_model` | `SolventModel` | `"none"` | `"none"`, `"alpb"`, `"gbsa"` |
| `solvent_name` | `string \| null` | `null` | Solvent for implicit solvation |
| `force_recompute` | `bool` | `false` | Bypass cache |

**Base response shape (`QmRespBase`):**

| Field | Type | Description |
|---|---|---|
| `job_id` | `UUID` | `qm_jobs` row ID |
| `cache_hit` | `bool` | Whether result was served from cache |
| `status` | `string` | `"succeeded"` |
| `summary` | `string` | Human-readable summary |
| `method` | `string` | Method used |
| `task` | `string` | Task type |

**`POST /single_point`** — Energy, HOMO/LUMO, dipole. Timeout: `_XTB_TIMEOUT` (default 120 s).

Additional response fields: `energy_hartree` (float|null), `homo_lumo_eV` (float|null), `dipole` (list[float]|null)

---

**`POST /geometry_opt`** — Geometry optimization.

Additional request field: `threshold` (`"crude" | "loose" | "normal" | "tight" | "vtight"`, default `"tight"`)

Additional response fields: `optimized_xyz` (string), `energy_hartree` (float|null), `gnorm` (float|null), `converged` (bool). Timeout: 120 s default.

---

**`POST /frequencies`** — Hessian, IR frequencies, and thermochemistry (ZPE, G298, H298, S298). Timeout: 300 s.

Additional response fields: `frequencies_cm1` (list[float]), `ir_intensities` (list[float]), `thermo` (dict[str, float] — keys: `g298`, `h298`, `ts298`, `zpe`)

---

**`POST /relaxed_scan`** — Relaxed potential energy scan along a bond, angle, or dihedral coordinate. Timeout: 300 s.

Additional request model (`RelaxedScanIn`) includes `coord_def`:

| Field | Description |
|---|---|
| `type` | `"bond" \| "angle" \| "dihedral"` |
| `atoms` | Atom indices (2 for bond, 3 for angle, 4 for dihedral) |
| `range` | `[lo, hi, step]` — max `MAX_SCAN_POINTS` points |

Additional response fields: `points` (list[dict] — `{point_index, energy_hartree}` pairs)

---

**`POST /md`** — NVT molecular dynamics (xTB -md). Timeout: 300 s.

Additional request fields: `n_steps` (int, 10–`MAX_MD_STEPS`, default 2000), `dt_fs` (float, > 0, ≤ 10, default 1.0), `temp_K` (float, > 0, default 298.15)

Additional response fields: `n_frames` (int)

---

**`POST /excited_states`** — sTDA-xTB vertical excitation energies. Requires `stda` binary; returns HTTP 501 if absent.

Additional request field: `n_states` (int, 1–50, default 10)

Additional response fields: `states` (list[dict] — `{state, e_eV, osc_strength}`)

---

**`POST /fukui`** — Fukui indices f+, f-, f0 per atom. Method: `xtb --vfukui`.

Additional response fields: `f_plus` (list[float]), `f_minus` (list[float]), `f_zero` (list[float])

---

**`POST /charges`** — Mulliken / CM5 partial charges per atom.

Additional request field: `scheme` (`ChargeScheme`: `"mulliken"`, default)

Additional response fields: `charges` (list[float]), `scheme` (string)

---

**`POST /redox`** — IPEA-xTB vertical ionization energy, electron affinity, and estimated redox potential.

Additional request fields: `electrons` (int, default 1), `reference` (`"SHE" | "Fc"`, default `"SHE"`)

Additional response fields: `redox_potential_V` (float|null), `vertical_ie_eV` (float|null), `vertical_ea_eV` (float|null), `reference` (string)

Conversion: `E_red = −EA − 4.281 eV` vs. SHE (Trasatti convention); Fc reference subtracts an additional 0.4 V.

---

**`POST /transition_state`** — Returns HTTP 501. Route and Pydantic shape are stable; implementation requires xtb-path / pyGSM (tracked in BACKLOG).

**`POST /irc`** — Returns HTTP 501. Requires xtb-irc driver.

**`POST /metadynamics`** — Returns HTTP 501. CV definition not yet wired.

**`POST /pka`** — Returns HTTP 501. Redirects to `mcp-crest` for CREST -pka mode.

**`POST /nci`** — Returns HTTP 501. Requires NCIPLOT integration.

**`POST /nmr_shieldings`** — Returns HTTP 501. xTB does not natively support NMR shieldings.

---

**Backwards-compatible endpoints (Phase 1 shape):**

**`POST /optimize_geometry`** — Convenience wrapper; maps `"GFN2-xTB"` → `"GFN2"`, `"GFN-FF"` → `"GFN-FF"`. Returns `{optimized_xyz, energy_hartree, gnorm, converged}` without cache metadata.

**`POST /conformer_ensemble`** — Boltzmann-weighted CREST ensemble. Each conformer is xTB-optimized before Boltzmann weighting. Request: `{smiles, n_conformers}` (1–`MAX_CONFORMERS`, default 20). Response: `{conformers: [{xyz, energy_hartree, weight}]}`. Internally calls the `optimize_ensemble` workflow recipe.

---

**`POST /run_workflow`** — Execute a named multi-step recipe.

Request (`RunWorkflowIn`):

| Field | Type | Constraints | Description |
|---|---|---|---|
| `recipe` | `string` | 1–64 chars | Recipe name (keys in `RECIPES` registry) |
| `inputs` | `dict` | max 32 keys | Recipe-specific inputs |
| `total_timeout_seconds` | `int \| null` | ≥ 1; hard-capped at 1800 | Override per-workflow timeout |

Response: `WorkflowResult` — `{success, steps: [{name, ok, error, duration_s}], outputs: dict}`

Default timeouts: step = `MCP_XTB_STEP_TIMEOUT_SECONDS` env var (default 120 s); workflow = `MCP_XTB_WORKFLOW_TIMEOUT_SECONDS` (default 600 s); hard ceiling = 1800 s.

---

### `mcp-askcos` (port 8007)

ASKCOS v2 retrosynthesis and condition recommender. Requires pretrained model checkpoint directory at `ASKCOS_MODEL_DIR`. `/readyz` returns 503 if missing.

**`POST /retrosynthesis`**

Request (`RetrosynthesisIn`):

| Field | Type | Constraints | Default |
|---|---|---|---|
| `smiles` | `string` | 1–`MAX_SMILES_LEN` | — |
| `max_depth` | `int` | 1–6 | `3` |
| `max_branches` | `int` | 1–10 | `4` |

Response (`RetrosynthesisOut`): `routes` (list[`RetroRoute`])

`RetroRoute`: `steps` (list[`RetroStep`]), `total_score` (float ≥ 0), `depth` (int ≥ 1)

`RetroStep`: `reaction_smiles` (string), `score` (float 0–1), `sources_count` (int ≥ 0)

---

**`POST /forward_prediction`**

Request (`ForwardPredictionIn`): `reactants_smiles` (string, required), `conditions` (string|null, max 1000 chars)

Response (`ForwardPredictionOut`): `products` (list[`ForwardProduct`])

`ForwardProduct`: `smiles` (string), `score` (float 0–1)

---

**`POST /recommend_conditions`**

Condition recommendation (Coley/Gao 2018 + 2024 refresh): given reactants + product, return top-k catalyst/reagent/solvent/temperature condition sets.

Request (`RecommendConditionsIn`):

| Field | Type | Constraints | Default |
|---|---|---|---|
| `reactants_smiles` | `string` | 1–`MAX_SMILES_LEN` | — |
| `product_smiles` | `string` | 1–`MAX_SMILES_LEN` | — |
| `top_k` | `int` | 1–20 | `5` |

Response (`RecommendConditionsOut`): `recommendations` (list[`ConditionSet`]), `model_id` (string, default `"askcos_condition_recommender@v2"`)

`ConditionSet`: `catalysts` (list[`CompoundRef`]), `reagents` (list[`CompoundRef`]), `solvents` (list[`CompoundRef`]), `temperature_c` (float|null, −100 to 500), `score` (float 0–1)

`CompoundRef`: `smiles` (string), `name` (string)

---

### `mcp-aizynth` (port 8008)

AiZynthFinder retrosynthesis tree builder. Requires policy network + stock files at `AIZYNTH_CONFIG` (default `/var/lib/mcp-aizynth/configs/config.yml`). `/readyz` returns 503 if missing.

**`POST /retrosynthesis`**

Request (`AiZynthRetrosynthesisIn`):

| Field | Type | Constraints | Default |
|---|---|---|---|
| `smiles` | `string` | 1–`MAX_SMILES_LEN` | — |
| `max_iterations` | `int` | 1–1000 | `100` |
| `stocks` | `list[string] \| null` | max 20 elements | `null` (all configured stocks) |

Response (`AiZynthRetrosynthesisOut`): `routes` (list[`RetroRoute`])

`RetroRoute` (AiZynth shape): `tree` (dict — full AiZynthFinder route tree), `score` (float ≥ 0), `in_stock_ratio` (float 0–1 — fraction of required building blocks in virtual stock)

---

### `mcp-applicability-domain` (port 8017)

Three-signal applicability-domain verdict service. Stateless math with a 30-minute LRU cache of per-project calibration sets (max 256 entries). Requires `drfp_stats_v1.json` artifact at startup for the Mahalanobis signal.

**`POST /calibrate`**

Store per-project conformal calibration residuals (|true_yield − predicted_yield|) for a 30-minute cache window.

Request (`CalibrateIn`): `project_id` (string, 1–64 chars), `residuals` (list[float], 1–1000 elements, all ≥ 0 and finite)

Response (`CalibrateOut`): `calibration_id` (string — deterministic SHA-256 prefix of project_id + sorted residuals), `calibration_size` (int), `cached_for_seconds` (int, always 1800)

---

**`POST /assess`**

Three-signal AD verdict for a query reaction.

Request (`AssessIn`):

| Field | Type | Constraints | Description |
|---|---|---|---|
| `query_drfp_vector` | `list[float]` | exactly 2048 elements | Binary DRFP vector of the query reaction |
| `nearest_neighbor_distance` | `float` | 0.0–1.0 | Pre-computed cosine distance to nearest neighbor in the training corpus |
| `calibration_id` | `string \| null` | max 64 chars | From `/calibrate`; preferred over inline |
| `inline_residuals` | `list[float]` | max 1000 elements | Fallback when no cached calibration |

Response (`AssessOut`):

| Field | Type | Description |
|---|---|---|
| `verdict` | `string` | `"in_domain" \| "borderline" \| "out_of_domain"` |
| `tanimoto_signal` | `TanimotoSignal` | Distance-based signal |
| `mahalanobis_signal` | `MahalanobisSignal` | Global distribution signal from DRFP stats artifact |
| `conformal_signal` | `ConformalSignal \| null` | Null if calibration has < 30 residuals |
| `used_global_fallback` | `bool` | True when inline_residuals used or conformal is null |

Signal thresholds:

| Signal | In-band | Out-of-band |
|---|---|---|
| Tanimoto distance | ≤ 0.50 | ≥ 0.70 |
| Mahalanobis | ≤ `threshold_in` from stats artifact | ≥ `threshold_out` |
| Conformal half-width (80% coverage) | ≤ 30 pp | ≥ 50 pp |

Verdict aggregation: `in_domain` requires all available signals in-band; `borderline` requires majority (⌈n/2⌉); `out_of_domain` if fewer than majority are in-band.

Error: HTTP 503 if the drfp_stats artifact was not loaded at startup. HTTP 404 if `calibration_id` is not in cache (re-supply via `/calibrate` and retry).