# Plan: BO-driven HPLC method optimization (column · eluent · gradient)

Status: **concept** (May 2026). Target branch: `claude/bo-chromatography-optimization-203xg`.
Audience: agent + analytical-development chemists. Companion ADR (forthcoming): `docs/adr/012-chromatography-method-optimization.md`.

## 1. Context and motivation

Method development for reversed-phase HPLC/UHPLC is the single highest-touch
bottleneck in analytical development for medicinal-chemistry projects. Today
the chemist:

1. Picks a column from intuition / SOP (often a C18 default).
2. Picks A/B solvents and an additive (acid for low-pH, buffer for neutral).
3. Runs a generic 5–95 %B linear gradient over 15–30 min.
4. Tweaks gradient time, initial %B, and column choice in 5–20 manual rounds.

The literature has converged on three things:

- BO with a Gaussian-process surrogate beats DoE / LSS / QSRR / simplex on
  number-of-injections-to-baseline-resolution for non-trivial mixtures
  (Boelrijk et al. 2023; Gloria et al. 2024; Karaj-Nodehi et al. BAGO 2023;
  Vanderelst & Pirok 2024 deep-RL extension).
- The chromatographic response function (CRF) — the scalar objective —
  matters more than the surrogate. Standard CRFs (Berridge, Watson-Carr,
  Schoenmakers) reward-hack; the Niezen-Desmet 2024 self-adaptive CRF is the
  current state of the art.
- Multi-objective BO (Pareto over resolution × runtime × solvent footprint
  × robustness) is preferable to a hand-weighted CRF when the chemist
  cannot defend the weights up-front.

ChemClaw already has the plumbing to do this without a green-field build.
The objective of this plan is to specify the **decision-variable encoding**,
the **objective function(s)**, the **constraints**, and the **add-on services**
needed to extend the existing BoFire-driven reaction-optimization stack into
analytical-method optimization.

## 2. Goals and non-goals

### In scope

- Optimise *column choice*, *eluent system* (B-solvent + additive/buffer),
  *gradient program*, *flow rate*, and *column temperature* — jointly, in
  one BO loop.
- Single-objective (scalar CRF) and multi-objective (Pareto) modes.
- Cold-start space-filling → warm BO transition (matches the existing
  `mcp_reaction_optimizer` pattern, with `MIN_OBSERVATIONS_FOR_BO`).
- Closed-loop ingestion of peak lists from `mcp_logs_sciy` (already wired
  into `source-cache` post-tool hook + `kg_source_cache` projector).
- Reuse `optimization_campaigns` / `optimization_rounds` and the
  `synthesis_campaigns.kind = 'bo_campaign' | 'bo_or_die'` orchestration —
  no new umbrella state machine.

### Out of scope (defer)

- Hardware autonomy (auto-dispatch of injections to a Vanquish / Agilent
  Method Development System) — pluggable via a future
  `mcp_instrument_<vendor>` adapter; the agent hands the chemist a method
  file until then.
- 2D-LC, SFC, IEX, HILIC method development. RP only for v1.
- Charge-variant / size-exclusion / aggregation methods (different CRF
  shape; covered in the Niezen-Desmet 2024 SEC paper).
- Fully data-driven retention modelling (QSRR with foundation models). v1
  treats retention as black-box; v2 adds an LSS warm-start (§ 9).

## 3. What ChemClaw already has (reuse, do not duplicate)

| Capability | Where | Reuse as |
|---|---|---|
| BoFire 0.3.x Domain build + SOBO/MOBO suggest/observe | `services/mcp_tools/mcp_reaction_optimizer/` (port 8018) | Template for new chromatography MCP. Same JSON contract, same `ContinuousInput` / `CategoricalInput` / `ContinuousOutput` primitives. |
| Campaign + round persistence with `bofire_domain JSONB` | `db/init/21_optimization_campaigns.sql`; `optimization_campaigns` + `optimization_rounds` | Direct reuse — the Domain we define for chromatography is just a different shape. RLS on `nce_project_id` already correct. |
| Closed-loop skill pack | `skills/closed-loop-optimization/SKILL.md` | Sibling pack `skills/hplc-method-optimization/` clones the round-0 / iterate / ingest verbs with chromatography-specific defaults. |
| Synthesis campaign DAG | `db/init/51_synthesis_campaigns.sql`; `synthesis_campaign_steps.kind` enum | Add `analytical_method_optimization` to the enum so an HPLC method-dev step can be a node in an umbrella `single_experiment` / `library_synthesis` campaign. |
| LOGS-by-SciY HPLC peak ingestion | `mcp_logs_sciy` (port 8016); `fake_logs.datasets` + `tracks` JSONB; builtins `query_instrument_runs` / `fetch_instrument_run` | Source of measured peak lists. Peaks already include `rt_min`, `area`, `height`, `m_z`, optional `name`. |
| HPLC instrument run schema (Pydantic) | `services/mcp_tools/mcp_instrument_template/main.py:44-72` (`HplcRun`, `ChromatographicPeak`) | Canonical peak shape — extend, do not redesign. |
| Source-cache hook regex `^(query\|fetch)_(eln\|lims\|instrument)_` | `hooks/source-cache.yaml` + post-tool implementation | New builtins should match this regex (e.g. `query_instrument_runs_for_campaign`) so caching + KG projection are free. |

**Gaps**: no canonical `analytical_methods` table; no `column_inventory` with
Tanaka descriptors; no peak-list-to-CRF service; no monotonicity / mixture
constraints used in any current Domain; the single existing example
(`mcp_reaction_optimizer`) treats every input as independent and unconstrained.

## 4. Decision-variable design — the BO Domain

The Domain is the contract between the chemist's intent and the surrogate.
Get this wrong and the surrogate wastes data on irrelevant axes.

### 4.1 Column choice — `CategoricalDescriptorInput`, not `CategoricalInput`

The default "categorical column" encoding (one-hot) gives the GP no way to
generalise from "we tried Acquity BEH C18" to "Kinetex EVO C18 will behave
similarly". With ~20 candidate columns and a budget of 10–40 injections,
this is fatal — the surrogate sees each column as fully novel.

**Encoding**: `CategoricalDescriptorInput(key="column", categories=[...],
descriptors=["kPB", "alphaCH2", "alphaT_O", "alphaC_P", "alphaB_P_pH27",
"alphaB_P_pH76"], values=[[...], [...], ...])` — the standard 6-axis
**Tanaka characterization** (hydrophobicity + methylene selectivity + steric
selectivity + H-bond capacity + ion-exchange at pH 2.7 and 7.6).

The 6 Tanaka descriptors give the GP a continuous embedding of column
similarity. After three injections on three different columns the GP can
already make calibrated predictions for the other 17 — the same trick that
descriptor-based encoding pulls in solvent / catalyst BO.

**Seed catalogue** (initial `column_inventory` rows): Waters Acquity BEH
C18, BEH Phenyl, BEH Shield RP18, CSH C18, CSH Phenyl-Hexyl, HSS T3, HSS
PFP; Phenomenex Kinetex C18, EVO C18, Biphenyl, F5 (PFP), Polar C18; YMC
Triart C18, Triart C18 ExRS; Agilent Poroshell HPH-C18, EC-C18, EC-CN,
Bonus-RP. ~17 columns × 6 descriptors. Add Restek Raptor ARC-18 and Polar
X for later expansion. Source: published Tanaka tables + USP / PQRI /
HPLCColumns.org databases.

**Future**: when the chemist constrains the design space ("UHPLC only",
"phenyl phases only"), encode as a domain-build-time filter — do not push
this into the GP via a binary flag.

### 4.2 Eluent system

Two tiers, chosen at campaign creation:

**Tier A — fixed binary system** (most common): A = water, B = organic.
The factor space is then:
- `B_solvent`: `CategoricalInput["MeCN", "MeOH", "MeOH:MeCN_50:50", "IPA"]`
  (categorical only; the GP has no way to interpolate "70 % MeCN +
  30 % MeOH" cleanly without explicit mixture handling, and that shape
  is rarely useful for RP screening).
- `additive`: `CategoricalInput["TFA_0.1pct", "FA_0.1pct", "AcOH_0.1pct",
  "NH4OAc_10mM_pH4.5", "NH4HCO3_10mM_pH9.0", "NH4OH_pH10"]` —
  chosen jointly with `B_solvent` (some additives incompatible with MS).
  Encode as a separate categorical; downstream constraint disallows
  TFA + MS-compatibility flag.
- `pH_target`: derived from additive — **do not** model independently. The
  GP cannot disentangle pH from additive when both are categorical
  features anyway.

**Tier B — ternary mixture** (rare; method-dev specialists only):
A = water, B = organic-1, C = organic-2, with a mixture constraint
`xA + xB + xC = 1` and per-component bounds. Encode via three
`ContinuousInput`s with a `LinearEqualityConstraint([1,1,1], rhs=1)`
sum-to-one — BoFire supports this natively. `xA` is implicit (bounded by
gradient program), so usually we model `xB`, `xC` with `xA = 1 - xB - xC`.

v1 ships **Tier A only**. Tier B added in phase 4 once we have a
real-method case demanding it (e.g. closely-eluting positional isomers
where MeCN/MeOH alone won't separate).

### 4.3 Gradient — the central question

The gradient program g(t) maps `time → %B`. It is a *function*, not a
scalar. The choice of parameterization determines:

- BO sample efficiency (high-dim ⇒ slow convergence)
- Realism (over-parameterised ⇒ pathological staircase gradients win the
  CRF)
- Whether monotonicity is automatic or a constraint to enforce

We compared four schemes:

| Scheme | Params | Realism | BO-friendly | Notes |
|---|---|---|---|---|
| **(P1)** Single linear ramp | 3: `t_init_hold`, `t_grad`, `%B_init`, `%B_final` (4) | Low — generic gradients | Excellent | Operator-free RSC 2024 used this exact 3-var encoding (varies hold + initial + grad time, fixes %B_final at 95 %). Good v1 default. |
| **(P2)** Hold–ramp–hold | 5: `t_hold_init`, `%B_init`, `t_grad`, `%B_final`, `t_hold_final` | Medium | Good | Adds final-hold for late-eluters. Recommended **default for v1**. |
| **(P3)** Multi-segment piecewise linear | 2N+1 for N breakpoints (typically N=3 ⇒ 7 params) | High | Tractable up to N=4 with monotonicity LP constraint | Boelrijk et al. 2023 used a slope-per-bin encoding that is mathematically equivalent. **Phase 3 default.** |
| **(P4)** Functional / Bezier basis | k control points (typically k=4–6 ⇒ 4–6 params, in unit interval) | High (smooth curvature) | Good | Nicely curvature-controlled; harder to interpret. Defer unless P3 pathologies surface. |

**Recommended encoding (v1)** — P2 hold–ramp–hold:

```python
ContinuousInput(key="t_hold_init_min",  bounds=(0.0, 5.0))
ContinuousInput(key="pctB_init",        bounds=(2.0, 50.0))
ContinuousInput(key="t_grad_min",       bounds=(2.0, 30.0))
ContinuousInput(key="pctB_final",       bounds=(50.0, 100.0))
ContinuousInput(key="t_hold_final_min", bounds=(0.0, 3.0))
LinearInequalityConstraint(
    features=["pctB_final", "pctB_init"], coefficients=[-1.0, 1.0],
    rhs=0.0,                                     # i.e. pctB_final >= pctB_init
)
```

**Recommended encoding (phase 3)** — P3 multi-segment with N=3 breakpoints
(t1, %B1), (t2, %B2), (t3, %B3), endpoints fixed at (0, %B_init) and
(t_total, %B_final):

```python
# Six free params per segment shape; total 2*3 = 6 params, plus the
# four envelope params. Monotonicity = chained linear inequalities:
LinearInequalityConstraint(features=["t1"], coefficients=[-1], rhs=-0.0)  # t1 >= 0
LinearInequalityConstraint(features=["t2","t1"], coefficients=[-1,1], rhs=0)  # t2 >= t1
LinearInequalityConstraint(features=["t3","t2"], coefficients=[-1,1], rhs=0)  # t3 >= t2
LinearInequalityConstraint(features=["pctB1","pctB_init"],  coefficients=[-1,1], rhs=0)
LinearInequalityConstraint(features=["pctB2","pctB1"],     coefficients=[-1,1], rhs=0)
LinearInequalityConstraint(features=["pctB3","pctB2"],     coefficients=[-1,1], rhs=0)
LinearInequalityConstraint(features=["pctB_final","pctB3"], coefficients=[-1,1], rhs=0)
```

These are vanilla `LinearInequalityConstraint`s — no nonlinear math, BoTorch's
`get_monotonicity_constraints` can be invoked under the hood when BoFire
hands them off to acquisition optimisation. Tested in `tests/unit/test_chrom_domain.py`
with a synthetic check that no proposal violates monotonicity.

### 4.4 Other operating parameters

- `flow_mLmin`: `ContinuousInput`, bounded by `column_inventory.max_flow_mLmin`
  (per-column constraint resolved at domain-build time, **not** as a soft
  GP constraint — would waste data).
- `T_col_C`: `ContinuousInput(bounds=(20.0, 60.0))`. Higher T reduces
  viscosity (lowers backpressure) and shifts selectivity. Critical
  variable, often skipped in manual workflows.
- `injection_volume_uL`: `ContinuousInput(bounds=(0.5, 10.0))` — usually
  fixed at start, included only if the chemist is fighting overload.
  Default: omit from the Domain unless explicitly requested.

### 4.5 Implicit / static parameters

- Detection mode (UV-DAD vs MS) is a campaign-level setting, **not** a BO
  variable — a different detector changes the CRF computation, not the
  search space. Stored on `optimization_campaigns.config_jsonb`.
- Pre-equilibration time is operationally fixed (5–10 column volumes); not
  a BO variable but is added to the run-time objective.
- Sample matrix and target analyte set are campaign-level. The CRF
  computation depends on them; the search space does not.

## 5. Objectives — the CRF is the load-bearing part

### 5.1 Why generic CRFs reward-hack

Common CRFs (Berridge 1985; Watson-Carr 1979; Schoenmakers 1986; Glajch 1980)
are weighted sums of three terms: number of peaks above a resolution
threshold, sum of resolutions, time penalty. Each has a known failure mode:

- **Berridge** (`Σ Rs - α(t_R_max - t_target) - β(t_R_first - t_min)`):
  rewards trivially over-resolved early peaks; penalty weights are
  arbitrary; pathological optimum is "spread peaks over an hour".
- **Watson-Carr CRF** (`Π (Rs/Rs_target)^a × (t/t_target)^-b`):
  multiplicative, so any pair with Rs near zero kills the score → noisy
  surrogate landscape.
- **Schoenmakers** (`min(Rs) - α(t_R - t_target)`): only sees the worst
  pair; insensitive to all other improvements; flat plateaus.
- **Glajch / COF** (sum of products): improves over Berridge but
  hand-weights are still required.

**Niezen & Desmet 2024** propose a CRF where the time penalty's weight
*self-adapts* based on whether resolution targets are met:

```
CRF_NiezenDesmet = (peaks_above_threshold) + λ(Rs_state) × (t_target - t_R_last) / t_target
```

with `λ` small while resolution targets are unmet (don't penalize time;
focus on resolving) and large once met (push for short runtime).
Reported "100 % correct on test set vs ~50 % for legacy CRFs". This is
our default scalar CRF.

### 5.2 Recommended objectives — three modes

#### Mode 1 — single-objective Niezen-Desmet CRF (default)

- One `ContinuousOutput("crf_total", MaximizeObjective(w=1.0))`.
- Strategy: `SoboStrategy` + `qLogEI`. Already wired in
  `mcp_reaction_optimizer` → reuse.

#### Mode 2 — multi-objective Pareto (preferred for production methods)

Three or four outputs:

```python
ContinuousOutput("min_resolution",   objective=MaximizeObjective(w=1.0))
ContinuousOutput("runtime_min",      objective=MinimizeObjective(w=1.0))
ContinuousOutput("solvent_pmi_g",    objective=MinimizeObjective(w=1.0))
# optional 4th — only if a robustness probe was run:
ContinuousOutput("robustness_score", objective=MaximizeObjective(w=1.0))
```

- Strategy: `MoboStrategy` + `qNEHVI` (BoFire 0.3.x supports this; matches
  the `optimization_campaigns.acquisition` enum).
- Hypervolume reference point: derived at domain build time from chemist's
  `must_separate_with_Rs >= 1.5`, `runtime_max_min`, `solvent_max_g`.
- Pareto extraction: existing `/extract_pareto` endpoint on
  `mcp_reaction_optimizer` works unchanged.

`min_resolution` (worst critical-pair resolution) is the right separation
metric here — peak count above threshold is too coarse for the GP, and
sum of resolutions is reward-hackable.

#### Mode 3 — close-to-target (rare, regulated methods)

USP / Ph. Eur. monograph methods often require *specific* retention times
or *specific* resolution values (e.g. "Rs between peaks 4 and 5 = 2.0 ±
0.2"). BoFire's `CloseToTargetObjective` handles this directly. Used for
method *transfer* / *qualification* rather than de novo discovery.

### 5.3 What the CRF needs from the peak list

Computing CRF from a chromatogram requires:

1. **Peak detection** (already done by the CDS / LOGS dataset — peaks are
   pre-extracted).
2. **Peak tracking** across injections — the same compound must keep its
   identity even when selectivity inverts. Use:
   - LC-MS: m/z + (optional) MS2 fingerprint similarity. Robust.
   - LC-UV: DAD spectral correlation (cosine ≥ 0.95) + retention-window
     prior. Less robust; flag low-confidence assignments to the chemist.
   - Cold-start (no reference run): rank by area, assume conservation of
     order — only valid for first 1–2 injections.
3. **Critical-pair selection**: for known target peaks, all
   adjacent-in-RT pairs of "tracked" peaks. For unknown impurities, all
   adjacent above an area threshold.
4. **Per-pair resolution** from peak widths (FWHM via height vs area, or
   USP tangent method) — already in the peak shape returned by
   `mcp_logs_sciy`.

This logic does **not** belong in the LLM; it is deterministic and
testable. It belongs in a new MCP service (§ 7.2).

### 5.4 Solvent footprint — a concrete formula

```
solvent_pmi_g = flow_mLmin × runtime_min × ρ_eluent × (avg_pctB / 100)
```

with `ρ_eluent` from the B-solvent identity (MeCN: 0.786 g/mL; MeOH: 0.792;
IPA: 0.786). Multiplied by 1.5–2× to account for re-equilibration.
A weight in `kg/year` is computable at the campaign level by multiplying
by injections-per-day × run-days. CHEM21 score is a categorical bonus
(e.g. MeOH > MeCN > THF for greenness); orthogonal axis if the chemist
asks for it.

## 6. Constraints

| Constraint | Type | Where enforced | Notes |
|---|---|---|---|
| Gradient monotonicity (`%B` non-decreasing across breakpoints) | `LinearInequalityConstraint`(s) | BoFire Domain | § 4.3 |
| `pctB_final >= pctB_init` | Same | Domain | Subset of monotonicity |
| Mixture sum-to-one (Tier B eluent) | `LinearEqualityConstraint` | Domain | § 4.2 |
| MS-incompatible additives forbidden when `detection_mode = "MS"` | Domain-build-time filter | Domain assembly (Python, before BoFire) | Pre-filter the categorical levels. |
| Per-column `flow ≤ flow_max` and `T ≤ T_max` | Domain-build-time per-column | When column = X is sampled, flow + T bounds tighten. | Implementable as conditional bounds; cleanest is a NChooseK-style group constraint per column SKU. v1 takes the conservative intersection of bounds; v2 adds per-column conditional bounds. |
| Total runtime ≤ chemist's hard cap | Black-box inequality | Output constraint via BoFire `MaximizeSigmoidObjective` on `runtime_max - runtime_min` | Or just bake into Niezen-Desmet CRF time penalty. |

## 7. Add-on services (proposed)

### 7.1 `mcp_chrom_method_optimizer` (new, port 8019)

**Direct sibling of `mcp_reaction_optimizer`**. Same JSON contract pattern:
stateless math service, canonical state in `optimization_campaigns` /
`optimization_rounds`, agent-claw builtins read/write the tables.

Endpoints:

- `POST /build_domain` — chromatography-aware sugar over BoFire Domain
  build. Inputs:
  ```jsonc
  {
    "gradient_scheme": "hold_ramp_hold",   // or "linear" | "multi_segment"
    "n_segments": 3,                        // for multi_segment
    "column_choices": ["BEH-C18", "CSH-C18", "HSS-T3", "Kinetex-EVO", ...],
    "b_solvent_choices": ["MeCN", "MeOH"],
    "additive_choices": ["FA_0.1pct", "TFA_0.1pct", "NH4OAc_10mM_pH4.5"],
    "detection_mode": "DAD",                // "MS" | "DAD" | "ELSD"
    "flow_bounds_mLmin": [0.2, 1.0],
    "T_bounds_C": [25.0, 55.0],
    "objectives": "multi_objective",        // or "niezen_desmet_crf"
    "runtime_target_min": 8.0,
    "rs_target": 1.5
  }
  ```
  Returns: BoFire Domain JSON (the same shape `optimization_campaigns.bofire_domain`
  expects), plus a `domain_summary` for the agent to display.

- `POST /recommend_next` — identical signature to the reaction optimizer
  endpoint (Domain + measured_outcomes → proposals). No chromatography
  knowledge inside — pure BoFire.

- `POST /materialize_method` — Domain proposal → vendor-agnostic method JSON
  ready for `mcp_logs_sciy` / a future `mcp_instrument_<vendor>`. Expands
  the gradient-shape parameters into a `method.gradient_table` with
  explicit (time_min, pctB) rows. This is *not* BO; it is a deterministic
  compiler. Lives here so the chromatography logic stays in one place.

- `POST /score_chromatogram` — input: peak list + objective spec; output:
  Niezen-Desmet CRF, min-resolution, runtime, solvent PMI, all the MO
  outputs. Agent calls this after every measured run before
  `ingest_campaign_results`. Internally delegates to a peak-tracker
  module (§ 7.2 may be merged into this; see open question § 13).

Project skeleton:
```
services/mcp_tools/mcp_chrom_method_optimizer/
  __init__.py
  main.py
  domain_builder.py        # gradient schemes, monotonicity constraints, eluent rules
  peak_tracker.py          # m/z + spectral matching across runs
  scorer.py                # Niezen-Desmet CRF + auxiliary objectives
  retention_lss.py         # phase-5 LSS warm-start (§ 9)
  requirements.txt         # bofire>=0.3.1,<0.4 ; pandas; pydantic
  Dockerfile
  tests/
```

### 7.2 `mcp_chrom_peak_scorer` (optional split, port 8020)

Pure deterministic peak-list-to-objectives scorer. Could live inside
`mcp_chrom_method_optimizer` (cleaner deployment, fewer hops); split out
only if a different consumer (e.g. a stand-alone analytical-QC pipeline)
needs the same logic. **Default: keep merged.**

### 7.3 `analytical_methods` canonical table (new)

```sql
-- db/init/52_analytical_methods.sql
CREATE TABLE analytical_methods (
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
  detection_mode           text NOT NULL,
  gradient_program         jsonb NOT NULL,    -- list of {time_min, pctB}
  injection_volume_uL      numeric(4,2),
  total_runtime_min        numeric(5,2) GENERATED ALWAYS AS
                             ((gradient_program->-1->>'time_min')::numeric) STORED,
  is_optimised             boolean NOT NULL DEFAULT false,
  is_qualified             boolean NOT NULL DEFAULT false,  -- ICH Q2 / regulatory
  parent_method_id         uuid REFERENCES analytical_methods(id),  -- transfer lineage
  created_at               timestamptz NOT NULL DEFAULT NOW(),
  -- bi-temporal
  valid_from               timestamptz NOT NULL DEFAULT NOW(),
  valid_to                 timestamptz,
  superseded_by            uuid REFERENCES analytical_methods(id)
);
-- RLS via nce_project_id (same pattern as optimization_campaigns).
```

This replaces the loose `method_name` string on `fake_logs.datasets` by
adding a `analytical_method_id uuid` column to that table (nullable for
back-compat). A backfill migration matches `method_name` strings to canonical
methods where possible.

### 7.4 `column_inventory` table (new)

```sql
-- db/init/53_column_inventory.sql
CREATE TABLE column_inventory (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor                text NOT NULL,
  product_line          text NOT NULL,           -- "Acquity BEH"
  chemistry             text NOT NULL,           -- "C18", "Phenyl-Hexyl", "PFP"
  particle_size_um      numeric(3,2) NOT NULL,
  pore_size_A           int          NOT NULL,
  dimensions_mm         text         NOT NULL,   -- "2.1x50"
  -- Tanaka characterization (descriptor vector for CategoricalDescriptorInput)
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
  pressure_max_bar      int          NOT NULL,
  is_msc                boolean      NOT NULL DEFAULT false,  -- MS-compatible
  source_doc_uri        text,                                   -- vendor PDS
  active                boolean      NOT NULL DEFAULT true
);
-- Globally readable (no RLS); seeded from public catalogues.
```

Initial seed of ~17–20 columns covering RP-HPLC orthogonality (C18,
phenyl, PFP, polar-embedded, polar-endcapped). Non-RP rows added when
HILIC / SFC support lands (out of scope for v1 but the table is shaped
to accept them).

### 7.5 Skill pack `skills/hplc-method-optimization/`

Mirrors `closed-loop-optimization/SKILL.md` but with:

- Different default factors (column / eluent / gradient / flow / T).
- Different default outputs (Niezen-Desmet CRF or three-way Pareto).
- Cold-start: scout-run round-0 — five space-filling injections across the
  chosen column subset rather than five conditions on one column.
- Round summary includes a `materialize_method` call so the chemist sees
  an executable method file, not just %B values.

Skill verbs (all new builtins, all match the source-cache regex):

- `start_chrom_campaign` — wraps `optimization_campaigns` insert + calls
  `/build_domain`.
- `recommend_next_chrom_batch` — wraps `/recommend_next`.
- `materialize_chrom_method` — wraps `/materialize_method`; returns JSON
  the chemist can paste / load.
- `ingest_chrom_results` — wraps `/score_chromatogram` over each of the
  measured runs in the round, then writes
  `optimization_rounds.measured_outcomes`.
- `query_instrument_runs_for_campaign` — convenience wrapper around
  `query_instrument_runs` that filters to runs cited as part of a
  specific campaign / round.

### 7.6 Synthesis-campaign-step kind extension

```sql
-- db/init/54_synthesis_campaign_kind_extension.sql
ALTER TABLE synthesis_campaign_steps DROP CONSTRAINT synthesis_campaign_steps_kind_check;
ALTER TABLE synthesis_campaign_steps ADD CONSTRAINT synthesis_campaign_steps_kind_check
  CHECK (kind IN ('reaction', 'workup', 'purification', 'characterization',
                  'analytical_method_optimization'));
```

A `bo_or_die` campaign whose synthesis target depends on baseline-resolved
analytics now expresses "develop the analytical method" as a first-class
node of its DAG, with `ref_table='optimization_campaigns'` and the
chromatography campaign as `ref_id`. Reuses the existing
`advance_synthesis_campaign` state machine — no new orchestration.

## 8. Surrogate / strategy choice

| Mode | Strategy | Acquisition | Min observations |
|---|---|---|---|
| Cold-start | `RandomStrategy` (Sobol) | `random` | 0 |
| SO warm BO | `SoboStrategy` | `qLogEI` | 5 (raised from `mcp_reaction_optimizer`'s 3 — chromatography has more nuisance variation per measurement) |
| MO warm BO | `MoboStrategy` | `qNEHVI` | 7 |
| Regulatory transfer (Mode 3) | `SoboStrategy` | `qLogEI` over `CloseToTargetObjective` | 5 |

GP defaults from BoFire are correct for our shapes:

- Continuous inputs: Matern-5/2 with ARD (default).
- `CategoricalDescriptorInput` for column: descriptor space gets Matern;
  no one-hot blow-up.
- Plain `CategoricalInput` (B-solvent, additive): one-hot — fine because
  cardinality is small (≤ 6).

Batch size: `n_candidates = 4–8` per round to match a typical autosampler
tray fill, with `qLogEI` / `qNEHVI` natively handling parallel selection
via Monte-Carlo joint optimisation.

## 9. Multi-fidelity warm-start with LSS retention modelling (phase 5)

The LSS (Snyder-Dolan) retention equation gives `log k = log k_w − S × φ`
where `φ` is volume-fraction organic and `k_w`, `S` are per-analyte
parameters. Bracketing scouting runs (two gradient times, e.g. 5 min and
20 min on the same column) determine `k_w` and `S` per peak. Once
known, *any* gradient program can be simulated in milliseconds — the
exact solution is the well-known integral relating gradient program to
elution time.

**Scheme**:

1. After round 0 (5 scouting injections), fit LSS per tracked peak.
2. Generate 10 000 Sobol candidates over the BO Domain.
3. Simulate `t_R` for each candidate with LSS → compute virtual CRF /
   resolution / runtime / PMI.
4. Use the simulator predictions as a *cheap fidelity*: train a low-cost
   GP and a high-cost GP on the same Domain; condition the high-cost GP
   on cheap-fidelity predictions (Kennedy-O'Hagan / linear correction).
5. Acquisition on the high-fidelity GP picks the next real injection.

BoFire 0.3.x does not ship multi-fidelity strategies; BoTorch does
(`MultiTaskGP` + cost-aware acquisitions). Two integration paths:

- **(A)** Bump the BoFire pin to a future 0.4 release if it lands MFBO
  (track the issue; defer until then).
- **(B)** Implement a thin `mcp_chrom_retention` service that exposes
  LSS-simulated predictions and use them only for cold-start *seeding*
  (run all 10 000 candidates through LSS → take top-50 by simulated
  CRF → pick 8 by greedy hypervolume → submit as round 1). This is not
  fully Bayesian but captures most of the MFBO win in practice. Recommended
  default — implement in v2.

This extension is *the* reason to start with a clean MCP boundary: today
`/recommend_next` is pure black-box BO; phase 5 adds an LSS-aware variant
without touching the agent or DB layer.

## 10. Hardware-in-loop (deferred to phase 6)

Today: agent emits a method file (via `materialize_chrom_method`); chemist
runs the method; LOGS-by-SciY ingests the resulting dataset; agent reads
peaks; closes the loop.

Tomorrow: a `mcp_instrument_<vendor>` adapter exposes
`POST /run_method(method_json) → run_id`. The agent submits methods
directly. Hooks into the existing `synthesis_campaign_orchestrator` skill
(`bo_or_die` already gates on experiment budget and no-improvement
rounds). This requires a real instrument and is out of scope for v1.

For now, the v1 path is operator-in-loop with very thin operator burden:
the chemist queues four methods on a method-development pump, runs them
overnight, batches the ingest in the morning. The Boelrijk / Gloria
papers ran this exact pattern.

## 11. Phasing

| Phase | Scope | Rough effort |
|---|---|---|
| **0 — schema** | `analytical_methods` + `column_inventory` tables; seed Tanaka catalogue; ADR 012; mock-ELN seed columns / methods. | 2–3 days |
| **1 — SO scaffold** | `mcp_chrom_method_optimizer` with `/build_domain` + `/recommend_next` for hold-ramp-hold gradient + categorical column (Tanaka descriptors) + categorical B-solvent + categorical additive + continuous flow + T. Single objective Niezen-Desmet CRF. Skill pack and 5 builtins. End-to-end smoke test with mock peaks. | 1–2 weeks |
| **2 — peak scorer** | `peak_tracker.py` (m/z + DAD spectral) + `scorer.py` (Niezen-Desmet CRF) wired through `/score_chromatogram` and `ingest_chrom_results`. Unit tests with synthetic peak lists. | 1 week |
| **3 — MO Pareto** | `MoboStrategy` + `qNEHVI` over min-resolution × runtime × PMI. New objective output spec in domain builder. Pareto extraction reused from Z6. | 3–5 days |
| **4 — multi-segment gradient** | P3 encoding with monotonicity constraints; defaults for N=3 breakpoints. Constraint plumbing through to BoTorch. Tier-B ternary eluent (mixture constraint). | 1–2 weeks |
| **5 — LSS warm-start** | `retention_lss.py` cheap-fidelity simulator; 10 000-candidate Sobol seeding with simulated-CRF top-K filtering. Optional QSRR for unknown analytes. | 2 weeks |
| **6 — hardware** | First `mcp_instrument_<vendor>` adapter; `synthesis_campaigns.kind = analytical_method_optimization` end-to-end trial. | depends on hardware. |

Phases 1–3 are the "useful chunk" — the chemist can already get value
once Phase 3 lands. Phases 4–6 are quality-of-life and autonomy.

## 12. Validation strategy

- **Reproduce Boelrijk 2023** on a synthetic peak generator (Gaussian
  peaks under LSS) for a 12-component dye mixture. Target: baseline
  resolution within 35 injections at MO; within 20 at SO. (Their numbers
  were 35 and 13 respectively.)
- **Reproduce Gloria 2024** on the same synthetic dye mixture but using
  only the three-variable encoding to confirm the v1 default is good
  enough for simple separations.
- **Regression test** on a real chemclaw mock-ELN method (e.g. an OFAT
  campaign's analytical method) — recover within 5 % of the chemist's
  hand-tuned CRF in ≤ 10 simulated rounds.
- **Adversarial test** for CRF reward-hacking: generate pathological
  chromatograms (peaks merged into one broad peak; gradients that
  push everything to the void volume); confirm Niezen-Desmet CRF rejects
  these where Watson-Carr does not.
- Standard `make test` suite + new `tests/unit/test_chrom_domain.py`,
  `tests/unit/test_chrom_scorer.py`, `tests/unit/test_chrom_peak_tracker.py`,
  and `tests/integration/test_chrom_campaign_roundtrip.py` (Postgres
  testcontainer; runs only when Docker is available).

## 13. Open questions / explicit tradeoffs

- **Peak-tracker confidence threshold**: m/z matching gives near-100 %
  reliability for LC-MS; DAD-only (UV) datasets may produce ambiguous
  peak assignments after a column or solvent change. Decision needed:
  fail-loud (refuse to score the chromatogram, ask chemist to label) vs
  fail-warn (score with a reduced confidence-weighted CRF). Recommend
  fail-loud — partial CRF is worse than no CRF for the surrogate.
- **Critical-pair selection for unknown impurities**: defaulting to "all
  adjacent peaks" produces a noisy `min_resolution`. An informed default
  would weight by peak area (the chemist mostly cares about resolving
  major impurities). Decision: weight by area unless `must_separate_with_Rs`
  is explicitly listed for a peak by name.
- **Per-column conditional bounds**: when `column = HSS T3` the flow cap
  is 1.0 mL/min; on a Kinetex EVO 2.6 µm it is 1.5 mL/min. The clean
  encoding is conditional bounds — BoFire 0.3.x can express these via
  per-category linear constraints involving the categorical descriptors,
  but the cleaner solution is a "constraint-aware sampler" that tightens
  bounds at acquisition optimisation time. v1 punts: take the
  intersection (1.0 mL/min). v2 implements proper conditioning.
- **BoFire pin upgrade**: v1 stays on `>=0.3.1,<0.4` to match
  `mcp_reaction_optimizer` and the existing `optimization_campaigns`
  state. Phase 4 (multi-segment monotonicity constraints with batch
  acquisition) and phase 5 (multi-fidelity) may force a 0.4+ bump.
  Track upstream releases; bump in a dedicated PR with parity tests on
  the existing reaction-optimizer regression suite.
- **Where does retention modelling live**: collapsing LSS into
  `mcp_chrom_method_optimizer` is the simplest deployment but couples a
  scientific tool to an optimisation service. Splitting into
  `mcp_chrom_retention` (port 8021) is cleaner long-term but adds a
  second hop. Decision deferred to phase 5.
- **Autonomy ladder**: should the BO loop auto-propose **and** auto-run
  the next batch when wired to a real instrument, or always wait for a
  chemist confirm? Recommend: gated by `synthesis_campaigns.kind` —
  `bo_campaign` requires confirm-each-round; `bo_or_die` may run unattended
  within its `budget_max_experiments` envelope (matches the existing
  contract).
- **Skill activation phrasing**: how does the chemist trigger this skill?
  Candidates: `/optimize-method`, `/develop-hplc-method`, or piggyback on
  `/synthesize` with a flag. Probably the first; align with the existing
  `/synthesize` slash-verb pattern.

## 14. References

### Bayesian optimization for liquid chromatography

- Boelrijk, J.; Pirok, B.W.J.; Ensing, B.; Forré, P. (2023).
  *Closed-loop automatic gradient design for liquid chromatography
  using Bayesian optimization.* Anal. Chim. Acta 1242, 340789.
  https://doi.org/10.1016/j.aca.2023.340789. The original BO-for-LC paper.
  Custom GP kernel for slope-encoded gradients.
- Gloria, A. et al. (2024). *Operator-free HPLC automated method
  development guided by Bayesian optimization.* Digital Discovery 3, 1393–1404.
  https://doi.org/10.1039/D4DD00062E. SO + MO BO; 3-variable encoding;
  13-injection convergence on dye mixtures.
- Karaj-Nodehi (2023). *Bayesian optimization of separation gradients to
  maximize the performance of untargeted LC-MS* (BAGO). bioRxiv
  2023.09.08.556930. Active-learning over >100 000 plausible gradients;
  10-injection convergence.
- Vanderelst, D.; Pirok, B.W.J. (2024). *Deep reinforcement learning for
  the direct optimization of gradient separations in liquid chromatography.*
  J. Chromatogr. A 1716, 464620. RL alternative to BO; useful as a
  baseline for phase-3 evaluation.
- Pirok, B.W.J. et al. (2018). *Gradient design for liquid chromatography
  using multi-scale optimization.* J. Chromatogr. A 1530, 110–119.
  Multi-scale gradient parameterization (P3 / P4 in § 4.3).

### Chromatographic response functions

- Niezen, L.E.; Desmet, G. (2024). *A new chromatographic response
  function with automatically adapting weight factor for automated
  method development.* J. Chromatogr. A 1730, 465212.
  https://doi.org/10.1016/j.chroma.2024.465212. The self-adaptive CRF
  used as the v1 default.
- Berridge, J.C. (1985). *Unattended optimisation of reversed-phase HPLC
  separations using the modified simplex algorithm.* J. Chromatogr. A
  244, 1–14. Original Berridge CRF.
- Schoenmakers, P.J. (1986). *Optimization of Chromatographic Selectivity*,
  J. Chromatogr. Library 35. The reference text on selectivity tuning.

### Column characterization

- Tanaka, N. et al. (1989). *Selectivity of stationary phases…*
  J. Chromatogr. Sci. 27, 721. Original Tanaka 6-axis test.
- Žuvela, P. et al. (2019). *Column Characterization and Selection
  Systems in Reversed-Phase High-Performance Liquid Chromatography.*
  Chem. Rev. 119, 3674–3729. Comprehensive review of Tanaka, USP, PQRI,
  Snyder-Dolan-Carr classification systems.
- HPLCColumns.org public database (>600 columns characterized) — primary
  source for `column_inventory` Tanaka descriptors.

### BoFire / BoTorch

- Anselmi, S. et al. (2024). *BoFire: Bayesian Optimization Framework
  Intended for Real Experiments.* arXiv:2408.05040. Framework reference.
- Balandat, M. et al. (2020). *BoTorch: A Framework for Efficient
  Monte-Carlo Bayesian Optimization.* NeurIPS. Includes
  `get_monotonicity_constraints` and the qNEHVI / qLogNEI acquisition
  derivations.

### Multi-fidelity BO in chemistry

- Buoso, S. et al. (2025). *Best practices for multi-fidelity Bayesian
  optimization in materials and molecular research.* Nat. Comput. Sci.
- Folch, J. et al. (2024). *Applying Multi-Fidelity Bayesian Optimization
  in Chemistry.* arXiv:2409.07190. The 10–100× cost ratio + ρ ≥ 0.9
  correlation rule of thumb for MFBO break-even.
