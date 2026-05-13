# Implementation plan: BO-driven HPLC method optimization

Companion to `bo-chromatography-method-optimization.md`. This file is the
**actionable** breakdown — what gets built, in what order, with what tests,
under what merge gate.

Branch: `claude/bo-chromatography-optimization-203xg`. Target: PR into `main`
once Phase 1 lands (Phases 2–6 ship as follow-up PRs).

**Status (2026-05-13):** Phases 0+1 merged in PR #155. Phases 2–5 merged in
the follow-up PR — peak tracker + Niezen-Desmet CRF scorer (`/score_chromatogram`
live, `ingest_chrom_results` builtin), Pareto extraction (`/extract_pareto`,
`extract_chrom_pareto_front` builtin), multi-segment gradients (chained
monotonicity constraints) + ternary eluent (`eluent_mode`), and LSS
cheap-fidelity simulation (`retention_lss.py`, `/simulate_retention`,
`/seed_candidates_lss`, `simulate_chrom_retention` builtin). Phase 6
(hardware-in-loop via `mcp_instrument_<vendor>` adapter) remains open —
needs real instrument access; see `docs/runbooks/chromatography-method-optimization.md`.
Deferred follow-ups: DAD-spectral peak tracking, cost-aware MFBO acquisition,
gradient-scouting LSS fit, the Boelrijk-2023 synthetic-mixture benchmark
(BACKLOG).

## Success criteria (per CLAUDE.md hard rule 3)

A "Phase N done" gate is **observable** behaviour, not "I wrote the file":

- Phase 0: `make db.init` applies cleanly on a fresh DB; `SELECT count(*) FROM column_inventory WHERE active` ≥ 17; `SELECT count(*) FROM analytical_methods` works (table exists).
- Phase 1: `curl POST /build_domain` on the chromatography MCP returns a valid BoFire Domain JSON; `start_chrom_campaign` builtin inserts an `optimization_campaigns` row with `bofire_domain` round-trippable; agent-claw `npm test` green; `pytest services/mcp_tools/mcp_chrom_method_optimizer/tests/` green.
- Phase 2: `score_chromatogram` returns deterministic CRF on a synthetic peak list; reproduces a published Berridge-vs-Niezen-Desmet ranking ordering on three reference chromatograms.
- Phase 3: MoboStrategy + qNEHVI passes integration test on a synthetic 12-peak mixture (recover Pareto front in ≤ 35 simulated rounds).
- Phase 4: monotonicity violation rate over 1000 random proposals = 0; ternary-eluent mixture sums to 1.0 within 1e-6.
- Phase 5: LSS warm-start halves the rounds-to-convergence on the synthetic mixture (vs Phase 3 baseline).

## Scope of this session

Phases 0 and 1 land in this branch / PR. Phases 2–6 are scoped here for
continuity but ship as follow-on PRs (each its own branch off `main` per
hard rule 2).

Why this split: Phases 0+1 give the chemist a working closed-loop with a
simple CRF. Phase 2 adds the *correct* CRF; Phase 3 adds Pareto. Each is
a clean, testable increment.

## Phase 0 — Schema and seed data

### 0.1 `db/init/52_column_inventory.sql`

Globally readable table (no RLS — column SKUs are public catalogue data).

```sql
CREATE TABLE IF NOT EXISTS column_inventory (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor                text NOT NULL,
  product_line          text NOT NULL,
  chemistry             text NOT NULL,
  particle_size_um      numeric(3,2) NOT NULL,
  pore_size_A           int NOT NULL,
  dimensions_mm         text NOT NULL,
  -- Tanaka 6-axis descriptor
  tanaka_kPB            numeric(5,2),
  tanaka_alphaCH2       numeric(5,3),
  tanaka_alphaT_O       numeric(5,3),
  tanaka_alphaC_P       numeric(5,3),
  tanaka_alphaB_P_pH27  numeric(5,3),
  tanaka_alphaB_P_pH76  numeric(5,3),
  -- operating envelope
  pH_min                numeric(3,1) NOT NULL,
  pH_max                numeric(3,1) NOT NULL,
  T_max_C               numeric(4,1) NOT NULL,
  flow_max_mLmin        numeric(3,2) NOT NULL,
  pressure_max_bar      int NOT NULL,
  is_msc                boolean NOT NULL DEFAULT false,
  source_doc_uri        text,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (vendor, product_line, chemistry, particle_size_um, dimensions_mm)
);

GRANT SELECT ON column_inventory TO chemclaw_app, chemclaw_service;

INSERT INTO schema_version (filename, applied_at)
  VALUES ('52_column_inventory.sql', NOW())
  ON CONFLICT DO NOTHING;
```

### 0.2 `db/seed/03_column_inventory_seed.sql`

~17 rows covering:

- **C18 alkyl** (3): Acquity BEH C18 1.7 µm, CSH C18 1.7 µm, HSS T3 1.8 µm (Waters).
- **Phenyl-class** (3): BEH Phenyl 1.7 µm, CSH Phenyl-Hexyl 1.7 µm, Kinetex Biphenyl 2.6 µm (Phenomenex).
- **PFP** (2): Kinetex F5 2.6 µm; Restek Raptor F5 2.7 µm.
- **Polar-embedded / endcapped** (3): Bonus-RP (Agilent), Polar C18 (Phenomenex), HSS Cyano (Waters).
- **Core-shell C18** (3): Kinetex EVO C18 2.6 µm, Poroshell HPH-C18 2.7 µm (Agilent), Cortecs T3 1.6 µm (Waters).
- **YMC ARC-18** (1): Restek Raptor ARC-18 2.7 µm.
- **EVO** (2): Phenomenex EVO C18 2.6 µm, EVO Polar C18 2.6 µm.

Tanaka descriptors from the published vendor / Tanaka-database values.
Rows include `source_doc_uri` pointing to the vendor product spec (when
that URI is the literal vendor URL, fine; in test environments these will
be placeholders).

### 0.3 `db/init/53_analytical_methods.sql`

Project-scoped, RLS-enforced (matches `optimization_campaigns` pattern).

```sql
CREATE TABLE IF NOT EXISTS analytical_methods (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  nce_project_id           uuid NOT NULL REFERENCES nce_projects(id) ON DELETE CASCADE,
  campaign_id              uuid REFERENCES optimization_campaigns(id) ON DELETE SET NULL,
  round_id                 uuid REFERENCES optimization_rounds(id) ON DELETE SET NULL,
  method_name              text NOT NULL,
  technique                text NOT NULL CHECK (technique IN ('RP-HPLC','RP-UHPLC','HILIC','SFC')),
  column_id                uuid NOT NULL REFERENCES column_inventory(id),
  b_solvent                text NOT NULL,
  additive                 text NOT NULL,
  flow_mLmin               numeric(4,2) NOT NULL,
  T_col_C                  numeric(4,1) NOT NULL,
  detection_mode           text NOT NULL CHECK (detection_mode IN ('DAD','MS','ELSD','CAD','RID','MS-DAD')),
  gradient_program         jsonb NOT NULL,
  injection_volume_uL      numeric(4,2),
  total_runtime_min        numeric(5,2),
  is_optimised             boolean NOT NULL DEFAULT false,
  is_qualified             boolean NOT NULL DEFAULT false,
  parent_method_id         uuid REFERENCES analytical_methods(id),
  -- bi-temporal
  valid_from               timestamptz NOT NULL DEFAULT NOW(),
  valid_to                 timestamptz,
  superseded_by            uuid REFERENCES analytical_methods(id),
  created_by_user_entra_id text NOT NULL,
  etag                     bigint NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT NOW(),
  updated_at               timestamptz NOT NULL DEFAULT NOW()
);
-- triggers, RLS, grants — same as optimization_campaigns
```

`gradient_program` shape: `[{"time_min": 0.0, "pctB": 5.0}, {"time_min": 1.0, "pctB": 5.0}, ...]` — ordered, monotonic in `time_min`, monotonic non-decreasing in `pctB` if standard RP.

`total_runtime_min` is `MAX(time_min)` of the gradient program — denormalised for query convenience. No GENERATED column (jsonb path-arithmetic isn't immutable enough for STORED); set by a `BEFORE INSERT/UPDATE` trigger.

Forward-link from `fake_logs.datasets`: a follow-up migration adds `analytical_method_id uuid REFERENCES analytical_methods(id)` (nullable, no backfill) so that an injection can be cited as "made under method M". Defer to Phase 6 once hardware-in-loop produces the linkage automatically.

### 0.4 `db/init/54_synthesis_campaign_kind_extension.sql`

Add `analytical_method_optimization` to the `synthesis_campaign_steps.kind` CHECK constraint. Idempotent re-application via `DROP CONSTRAINT IF EXISTS` then re-add.

### 0.5 Tests

- `services/mcp_tools/common/tests/test_column_inventory_seed.py` — load seed, assert 17 rows, assert all Tanaka descriptors non-null, assert no duplicate `(vendor, product_line, chemistry, particle_size_um, dimensions_mm)`.
- `tests/integration/test_chrom_schema_round_trip.py` — start fresh DB, apply migrations, INSERT then SELECT a method, confirm RLS scoping.

## Phase 1 — Optimization MCP and minimal closed-loop

### 1.1 `services/mcp_tools/mcp_chrom_method_optimizer/`

```
mcp_chrom_method_optimizer/
├── __init__.py
├── main.py                  # FastAPI endpoints
├── domain_builder.py        # gradient schemes, eluent rules, monotonicity
├── optimizer.py             # thin wrapper around BoFire (delegates to mcp_reaction_optimizer's optimizer pattern)
├── scorer.py                # Phase 2 — Niezen-Desmet CRF (stub in Phase 1)
├── peak_tracker.py          # Phase 2 — peak tracking (stub in Phase 1)
├── retention_lss.py         # Phase 5 — empty placeholder
├── requirements.txt         # bofire>=0.3.1,<0.4 ; fastapi ; pydantic
├── Dockerfile               # Python 3.11-slim, UID 1001
└── tests/
    ├── __init__.py
    ├── test_domain_builder.py
    ├── test_endpoints.py
    └── test_scorer.py       # Phase 2 — empty in Phase 1
```

### 1.2 Endpoints (FastAPI)

`POST /build_domain` — Pydantic input:

```python
class GradientScheme(str, Enum):
    LINEAR = "linear"               # 4 params
    HOLD_RAMP_HOLD = "hold_ramp_hold"   # 5 params (default)
    MULTI_SEGMENT = "multi_segment"     # 4 + 2N params, Phase 4

class BuildChromDomainIn(BaseModel):
    gradient_scheme: GradientScheme = GradientScheme.HOLD_RAMP_HOLD
    n_segments: int = Field(default=3, ge=1, le=5)
    column_choices: list[str]            # column_inventory.id strings
    column_descriptors: list[list[float]] # [[kPB, alphaCH2, alphaT_O, alphaC_P, alphaB_P_pH27, alphaB_P_pH76], ...]
    b_solvent_choices: list[str]
    additive_choices: list[str]
    detection_mode: str
    flow_bounds_mLmin: tuple[float, float]
    T_bounds_C: tuple[float, float]
    objective_mode: str = "single"        # "single" | "pareto" | "close_to_target"
    runtime_target_min: float = 8.0
    rs_target: float = 1.5
```

Logic:

1. Build continuous inputs for the chosen gradient scheme (hold_ramp_hold ⇒ 5 inputs).
2. Build `CategoricalDescriptorInput("column", categories=column_choices, descriptors=["kPB",...], values=column_descriptors)`.
3. Build `CategoricalInput("b_solvent", ...)`, `CategoricalInput("additive", ...)`.
4. Build continuous inputs for `flow_mLmin`, `T_col_C`.
5. Build the `pctB_final >= pctB_init` `LinearInequalityConstraint`.
6. Build outputs based on `objective_mode`:
   - single: one `ContinuousOutput("crf_total", MaximizeObjective)`.
   - pareto: three outputs (`min_resolution`, `runtime_min`, `solvent_pmi_g`).
   - close_to_target: per-pair `CloseToTargetObjective` (Phase 3+).
7. Return Domain JSON via `domain.model_dump_json()`.

`POST /recommend_next` — identical interface to the reaction optimizer; delegate to a thin `optimizer.recommend_next_batch(domain, measured, n_candidates, seed)` that mirrors `services/mcp_tools/mcp_reaction_optimizer/optimizer.py`. (No chromatography knowledge — pure BoFire dispatch on the Domain we built.)

`POST /materialize_method` — input: a single proposal dict (factor values); output: a vendor-agnostic method JSON:

```python
{
  "technique": "RP-UHPLC",
  "column_id": "<uuid>",
  "b_solvent": "MeCN",
  "additive": "FA_0.1pct",
  "flow_mLmin": 0.4,
  "T_col_C": 40.0,
  "detection_mode": "DAD",
  "gradient_program": [
    {"time_min": 0.0, "pctB": 5.0},
    {"time_min": 0.5, "pctB": 5.0},   # initial hold
    {"time_min": 8.5, "pctB": 95.0},  # ramp end
    {"time_min": 10.0, "pctB": 95.0}, # final hold
  ],
}
```

This is a deterministic compiler — no BoFire involvement.

`POST /score_chromatogram` — Phase 2 (in Phase 1, returns 501 Not Implemented).

### 1.3 Common app integration

Use `services.mcp_tools.common.app.create_app(...)` exactly like `mcp_reaction_optimizer/main.py:43-50`. Required scope: `mcp_chrom_method_optimizer:invoke`.

Settings: `ToolSettings()` from `services.mcp_tools.common.settings` — port via `MCP_PORT` env var; host via `MCP_HOST`; log level via `MCP_LOG_LEVEL`. Set port to **8019** in `docker-compose.yml`.

### 1.4 docker-compose entry

Mirror `mcp-reaction-optimizer` block (sub-agent will report exact shape). Profile: `chemistry` (matches existing chemistry-tool services). `security_opt: [no-new-privileges:true]`. Healthcheck on `/healthz`.

### 1.5 Agent-claw builtins

Five new builtins under `services/agent-claw/src/tools/builtins/`. All match the source-cache regex `^(query|fetch)_(eln|lims|instrument)_` for the read-side and pure CRUD for write-side.

| Builtin | Reads | Writes | MCP endpoints called |
|---|---|---|---|
| `start_chrom_campaign.ts` | column_inventory (read), nce_projects (RLS check) | `optimization_campaigns` row | `/build_domain` |
| `recommend_next_chrom_batch.ts` | `optimization_campaigns`, `optimization_rounds` | `optimization_rounds` row | `/recommend_next` |
| `materialize_chrom_method.ts` | one `optimization_rounds.proposals` index | `analytical_methods` row | `/materialize_method` |
| `ingest_chrom_results.ts` | `optimization_rounds` | `optimization_rounds.measured_outcomes` | `/score_chromatogram` (Phase 2) |
| `query_chrom_columns.ts` | `column_inventory` | none | none — pure DB read |

Each follows the existing builtin shape:

- `name: string`
- `description: string` (LLM-facing)
- `inputSchema: zod` schema
- `handler(input, ctx) → Promise<ToolResult>`

`ctx` exposes `pool`, `userEntraId`, `projectId`, `getMcpClient(name)`. The `getMcpClient` factory is in `services/agent-claw/src/clients/mcp.ts` and includes JWT minting via `mintMcpToken`.

DB writes are wrapped in `withUserContext(pool, userEntraId, async (client) => ...)` so RLS bites. The `/build_domain` MCP call is inside a `withSystemContext(pool, ...)` because it's a stateless math call that doesn't touch user data — but the wrapping `start_chrom_campaign` builtin already runs under user context, so just pass `pool` directly.

Citations: the builtin returns `citations: [{type: 'campaign', id: campaignId}, {type: 'optimization_round', id: roundId}]`.

### 1.6 Builtin registration

Add each builtin to `BUILTIN_TOOLS` (or whatever the registry is — sub-agent confirms the exact name). Bump any `MIN_EXPECTED_TOOLS` boot invariant by +5.

### 1.7 Skill pack `skills/hplc-method-optimization/`

```
skills/hplc-method-optimization/
├── SKILL.md
└── README.md   # if convention demands, else absorb into SKILL.md
```

`SKILL.md` mirrors `closed-loop-optimization/SKILL.md` shape (sub-agent confirms YAML frontmatter). Tool list:

```yaml
tools:
  - canonicalize_smiles
  - query_chrom_columns
  - start_chrom_campaign
  - recommend_next_chrom_batch
  - materialize_chrom_method
  - ingest_chrom_results
  - query_instrument_runs       # read peak data from LOGS-by-SciY
  - fetch_instrument_run
  - manage_todos
  - query_kg
max_steps_override: 30
```

Skill description triggers: "develop an HPLC method", "optimize a chromatography method", "method dev for {compound}", "screen columns for {separation}".

### 1.8 Tests

**Python** (`services/mcp_tools/mcp_chrom_method_optimizer/tests/`):

- `test_domain_builder.py`:
  - `test_build_hold_ramp_hold_domain` — 5 continuous + 1 categorical-descriptor + 2 categorical + 2 ContinuousOutput (or 1 for SO).
  - `test_build_with_monotonicity_constraint` — confirm `LinearInequalityConstraint` present and shape correct.
  - `test_descriptor_input_carries_tanaka_values` — descriptors round-trip via JSON.
  - `test_pareto_domain_has_three_outputs` — for `objective_mode="pareto"`.
  - `test_invalid_gradient_scheme_raises` — pydantic rejection.
- `test_endpoints.py`:
  - `test_build_domain_returns_valid_bofire_json` — POST and round-trip via `Domain.model_validate(...)`.
  - `test_recommend_next_cold_start` — < 5 observations → returns space-filling proposals (`source` not in BO sources).
  - `test_recommend_next_warm_bo` — ≥ 5 observations → returns `qLogEI` proposals.
  - `test_materialize_method_emits_gradient_table` — confirm shape.
  - `test_score_chromatogram_returns_501_in_phase_1`.

**TypeScript** (`services/agent-claw/tests/unit/`):

- `start_chrom_campaign.test.ts` — fixture pool, mock MCP client, confirm INSERT into `optimization_campaigns`, RLS denial on wrong project.
- `materialize_chrom_method.test.ts` — confirm `analytical_methods` row created, gradient program well-formed.
- `query_chrom_columns.test.ts` — filter by `chemistry`, confirm Tanaka descriptors returned.

**Integration** (`services/agent-claw/tests/integration/`):

- `chrom_campaign_roundtrip.test.ts` — Postgres testcontainer; create campaign → recommend_next (cold) → ingest mock outcomes → recommend_next (warm). Self-skips when Docker not available (per existing convention).

### 1.9 Documentation

- `docs/runbooks/chromatography-method-optimization.md` — chemist-facing guide (when to start a campaign, what factors to set, how to ingest results, how to read the Pareto).
- Update `CLAUDE.md` Status section with a new bullet under "Synthesis-campaign orchestration": chromatography method-optimization landed (Phase 0+1).
- Update `docs/PARITY.md` if applicable (probably not — no harness change).

## Phase 2 — Peak tracker + Niezen-Desmet CRF (separate PR)

- `peak_tracker.py`: m/z + DAD spectral matching across runs; returns `tracked_peaks: list[TrackedPeak]` with confidence scores.
- `scorer.py`: Niezen-Desmet 2024 self-adaptive CRF; auxiliary computations (min-resolution, runtime, solvent PMI).
- `/score_chromatogram` endpoint goes from 501 to live.
- `ingest_chrom_results` builtin starts calling it.
- Reproducibility test: golden chromatograms with hand-computed CRF values; confirm < 1e-6 numerical agreement.

## Phase 3 — Multi-objective Pareto (separate PR)

- Wire `MoboStrategy` + `qNEHVI` end-to-end through the existing optimizer.
- Pareto extraction reuses `mcp_reaction_optimizer/extract_pareto`.
- Hypervolume reference point derived from chemist's `Rs_target`, `runtime_target_min`, `solvent_max_g`.
- Test: 12-peak synthetic dye-mixture benchmark from Boelrijk 2023, MoboStrategy converges to Pareto in ≤ 35 simulated rounds.

## Phase 4 — Multi-segment gradients + Tier-B eluent (separate PR)

- `GradientScheme.MULTI_SEGMENT` activated: 4 + 2N continuous inputs + chained monotonicity `LinearInequalityConstraint`s.
- Tier-B ternary mixture support: `xA + xB + xC = 1` `LinearEqualityConstraint`.
- Per-column conditional bounds (flow_max, T_max from `column_inventory`).
- Test: 1000 random proposals, monotonicity violation rate = 0.

## Phase 5 — LSS warm-start (separate PR)

- `retention_lss.py`: Snyder–Dolan retention model; bracketing-run fit; gradient simulation.
- `/build_domain` accepts a `lss_seed_runs: list[ScoutingRun]` field; if provided, the optimizer uses LSS-simulated CRF to filter 10 000 Sobol candidates → top 50 → greedy hypervolume → 8 proposals.
- Optional QSRR for unknown analytes (Phase 5b — deferred).

## Phase 6 — Hardware-in-loop (separate PR, requires hardware)

- `mcp_instrument_<vendor>` adapter implements `POST /run_method`.
- `synthesis_campaign_steps.kind = 'analytical_method_optimization'` end-to-end with `bo_or_die` budget gate.
- Runbook: `docs/runbooks/chromatography-hardware-in-loop.md`.

## Risk register

| Risk | Mitigation |
|---|---|
| BoFire 0.3.x JSON schema changes between minor versions | Pin `>=0.3.1,<0.4` matches `mcp_reaction_optimizer`; integration test re-validates Domain round-trip on every CI run. |
| BoTorch monotonicity constraints not honoured under qNEHVI batch sampling | Add a Phase 4 invariant test: 1000 acquisitions on a constrained Domain, assert all proposals satisfy the linear inequalities. If violated, fall back to rejection sampling. |
| Tanaka descriptor coverage gaps for newer columns | `column_inventory.tanaka_*` are nullable; if any descriptor is null, the domain builder downgrades that column to plain `CategoricalInput` (one-hot) at request time. |
| RLS regression on the new `analytical_methods` table | Mirror `optimization_campaigns` RLS exactly; add a test that asserts cross-project read denial. |
| LLM-fabricated peak assignments in `ingest_chrom_results` | All peak-tracking is server-side in `peak_tracker.py` (Phase 2). The agent never invents tracking decisions. |
| Reward-hacking by gradient pathologies | Phase 2 adversarial test: pathological chromatograms (peaks collapsed, dead-volume dumping) must score worse than reasonable ones under Niezen-Desmet CRF. |

## Merge / cleanup gate (per CLAUDE.md hard rule 2)

For each PR (this branch and follow-ups):

1. `make lint && make typecheck && make test` green locally.
2. `gh pr create` with a real description (link to design doc + this plan).
3. Wait for CI green; fix real failures (no `--no-verify`).
4. Run `/review` on own PR; iterate via fixup commits to the same branch.
5. `gh pr merge <N> --merge`.
6. Delete remote and local branch; remove worktree if used.
7. Backlog any deferred items in `BACKLOG.md`.
