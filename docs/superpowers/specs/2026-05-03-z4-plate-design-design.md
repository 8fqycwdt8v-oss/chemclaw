# Z4 Design — `mcp_plate_designer` + `mcp_ord_io` + `hte-plate-design` skill

**Date:** 2026-05-03
**Plan reference:** `~/.claude/plans/develop-an-extensive-plan-distributed-backus.md` (Phase Z4)
**Builds on:** Z0 (PR #64, merged), Z3 (PR #73, merged). Z1 (PR #71) and Z2 (PR #72) still open; Z4 is independent.

## Context

Z0 ships condition recommendations one-at-a-time. Z3 ships per-reaction yield UQ. The next-leverage capability is *batch experimentation*: given a target reaction, design a 96-well (or 24/384/1536) HTE plate that explores the condition space efficiently. Z4 does that. The plate becomes the design-space spec Z5's BoFire optimizer warm-starts from.

## Design choices (decided in brainstorming)

| Question | Decision |
|---|---|
| DoE strategy | **Space-filling only** via `domain.inputs.sample(n, seed)`. Z5 brings IPOPT-based D-optimal + acquisition functions. Z4's job is "give me 96 well-distributed starting points." |
| Yield pre-score | **Annotate, don't filter.** Plate designer returns DoE-optimal wells; the agent-claw builtin (optionally) calls `predict_yield_with_uq` (Z3) once on the unique reaction and broadcasts ensemble_mean/std to each well. |
| Greenness | **Built-in CHEM21 allowlist + optional Z1.** ~30-solvent allowlist baked into the plate-designer image; `mcp_green_chemistry` (Z1) provides richer scoring when deployed. Excluded solvents become a categorical-input restriction on the BoFire Domain. |
| ORD I/O | **Separate `mcp_ord_io` service** (port 8021). Reusable for non-plate ingestion paths. |
| Import support | **Deferred.** Z4's user-facing flow is plate *design*. `mcp_ord_io /import` exists but the builtin `import_from_ord.ts` is out of scope. |

## Architecture

### `mcp_plate_designer` (port 8020) — stateless

**Endpoints**:
- `POST /design_plate` — input shape per spec; output: `{wells, domain_json, design_metadata}`.
- `GET /healthz`, `/readyz`. `/readyz` checks the static CHEM21 allowlist file loads.

**Internals**:
1. Apply exclusions: drop user-supplied entries from each `categorical_inputs` list. Also auto-drop any `CHEM21 HighlyHazardous` entry from `solvents` even if not in user's exclusion list — defense-in-depth safety floor (logged as `applied_chem21_floor`).
2. Build BoFire `Domain` with `ContinuousInput` (continuous factors with `bounds`) and `CategoricalInput` (categorical factors with filtered `categories`).
3. `domain.inputs.sample(n=n_wells, seed=request_seed)` → DataFrame.
4. Convert to JSON-serializable list, attach `well_id` (A01..H12 for 96, A01..P24 for 384, etc.).
5. Emit canonical BoFire `Domain` JSON via `domain.model_dump()` so Z5 can warm-start.

**State**: `data/chem21_solvents_v1.json` shipped in the image; ~30 solvents, mirroring Z1's data. Read-only. JSON-serializable.

### `mcp_ord_io` (port 8021) — stateless

**Endpoints**:
- `POST /export` — input: `{plate, reactants_smiles, product_smiles}`; output: base64-encoded ORD `Dataset` protobuf bytes + a JSON summary of the protobuf shape.
- `POST /import` — input: `{ord_protobuf_b64}`; output: normalized JSON.
- `GET /healthz`, `/readyz`. `/readyz` confirms the `ord_schema` package imports.

**Internals**: pure protobuf marshaling via `ord_schema` package. No chemistry validation; assumes upstream callers have already canonicalized.

### Two new agent-claw builtins

- `design_plate.ts` — wraps `mcp_plate_designer /design_plate`; if `annotate_yield` set, calls `predict_yield_with_uq` (Z3 builtin) once on the unique rxn_smiles and broadcasts to every well. Returns the merged response.
- `export_to_ord.ts` — thin wrapper over `mcp_ord_io /export`. Returns base64 string the agent can render.

### Skill: `hte-plate-design`

In `skills/hte-plate-design/`. Activated by "design a 96-well screen", `/plate <smiles>`, etc. Playbook:

1. `canonicalize_smiles` reactants + product
2. `recommend_conditions` (Z0) → narrow categorical lists
3. *(optional, when Z1 lands)* `score_green_chemistry` for richer pre-filter
4. `design_plate` with ranges + exclusions + `annotate_yield: true`
5. *(optional, when Z1 lands)* `assess_applicability_domain` on the query reaction
6. Render plate map as a markdown table
7. *(optional)* `export_to_ord` for portable bundle

### Schema additions

One row in existing `model_cards` table for `mcp_plate_designer / plate_designer_v1`. No new tables, no new projectors, no new event types.

## Section 3 — Error handling, safety, testing (autonomous decisions)

### Error handling

| Failure | Behavior |
|---|---|
| User excludes ALL solvents | 422 with `code: empty_categorical: solvent` — can't design a plate with no solvent options. |
| `n_wells > 1536` | 422 (Pydantic Field constraint). |
| BoFire `domain.inputs.sample` raises (mathematically infeasible Domain) | 422 with `code: infeasible_domain` + the BoFire error message. |
| `mcp_yield_baseline` 5xx (annotate_yield=true) | Builtin returns the plate WITHOUT yield annotations; logs a warning. The plate is the load-bearing output; yield is enrichment. |
| `mcp_yield_baseline` 412 (Z3 cache miss) | Builtin handles via Z3's existing retry logic. |
| `ord_schema` package not loadable | `/readyz` 503; deploy blocked until image rebuilt with package installed. |
| Plate format unknown | 422 — only "24"/"96"/"384"/"1536" accepted. |
| Project ID supplied but RLS lookup empty | Yield annotation falls back to global model (Z3 behavior). |

### Safety policy — built-in CHEM21 floor

Even when the user does **not** include "DCM" in `exclusions.solvents`, the plate designer auto-drops any solvent matched against the built-in CHEM21 list with class `"HighlyHazardous"` from the categorical input — and records it in `design_metadata.applied_chem21_floor`. The chemist sees the floor was applied; can override by passing `disable_chem21_floor: true` (logged at WARN level for audit).

This is the safety-by-default principle inherited from Z1's soft-penalty design philosophy: defense in depth without paternalism. The user controls the override.

### Testing

**Three layers**:

1. **Pure-function unit tests** (`tests/test_designer.py`):
   - Build minimal Domain (1 continuous + 1 categorical), `n_wells=4`, deterministic seed → exactly the same 4 candidates twice.
   - Excluded solvent absent from results.
   - CHEM21 floor strips DCM even without explicit exclusion.
   - `disable_chem21_floor=true` keeps DCM available.
   - Empty categorical after exclusion → 422 `empty_categorical`.
   - Plate-format math: 96 → 8×12, 384 → 16×24.
   - Well_id A01..H12 generated correctly.
   - 8+ tests.

2. **`mcp_ord_io` tests** (`tests/test_ord_io.py`):
   - Round-trip: build plate → export → import → assert structure preserved.
   - Empty plate → empty Dataset.
   - Invalid base64 → 400.
   - 4+ tests.

3. **Builtin tests** (`design_plate.test.ts`, `export_to_ord.test.ts`):
   - Happy path: mock `/design_plate` + `/predict_yield_with_uq` → assert merged response.
   - `annotate_yield: false` skips yield call.
   - Yield service 503 → still returns plate, no yield fields.
   - 6+ tests across the two files.

## Out of scope

- **Plate visualization** — render is the agent's job (markdown table).
- **Robot-control protocol output** (PyLabRobot, Chemspeed) — Z4 stops at ORD; hardware adapters are tracked-for-later.
- **`import_from_ord.ts` agent-claw builtin** — service supports `/import`; builtin deferred until needed.
- **NChooseK constraints** — out of scope for Z4 (BoFire supports them but our plate designer offers a simple categorical-only API).
- **Plate-aware adjacency or randomization** — wells are space-filling samples; row/col layout is presentation only. Hardware-specific shuffle patterns (e.g., to spread positive controls across rows) are out of scope.

## Files

**New**: `services/mcp_tools/mcp_plate_designer/{__init__.py, main.py, designer.py, requirements.txt, Dockerfile, data/chem21_solvents_v1.json, tests/__init__.py, tests/test_designer.py}`; `services/mcp_tools/mcp_ord_io/{__init__.py, main.py, requirements.txt, Dockerfile, tests/__init__.py, tests/test_ord_io.py}`; `services/agent-claw/src/tools/builtins/{design_plate.ts, export_to_ord.ts}`; `services/agent-claw/tests/unit/builtins/{design_plate.test.ts, export_to_ord.test.ts}`; `skills/hte-plate-design/SKILL.md`.

**Modified**: `services/mcp_tools/common/scopes.py`, `services/agent-claw/src/config.ts`, `services/agent-claw/src/bootstrap/dependencies.ts`, `db/seed/05_harness_tools.sql`, `db/init/19_reaction_optimization.sql`, `docker-compose.yml`, `Makefile`.

## Verification

```bash
make up.full
make ps  # mcp-plate-designer + mcp-ord-io healthy
.venv/bin/pytest services/mcp_tools/mcp_plate_designer/tests/ services/mcp_tools/mcp_ord_io/tests/ -v
cd services/agent-claw && npm test
chemclaw chat "Design a 96-well Buchwald-Hartwig screen for 4-bromoanisole + morpholine, exclude DCM and DMF, T 60-120 C"
# Expected: 96 wells with factor values + ensemble yield ± std; ORD bytes available on request.
```
