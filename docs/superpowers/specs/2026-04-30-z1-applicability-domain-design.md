# Z1 Design — Applicability Domain & Green Chemistry

**Date:** 2026-04-30
**Plan reference:** `~/.claude/plans/develop-an-extensive-plan-distributed-backus.md` (Phase Z1)
**Builds on:** Z0 (PR #64, merged) — `mcp_askcos /recommend_conditions`, `recommend_conditions` builtin, `model_cards` table, `condition-design` skill v1.

## Context

Z0 shipped a forward condition recommender that proposes top-k condition sets given a target reaction. The recommender is USPTO-trained (top-10 ~70% accuracy, T MAE ~20 °C) and the agent currently surfaces its output verbatim, modulo a nearest-historical-analog citation and a chemprop yield sanity-check. Z0's `condition-design` skill explicitly defers two pharma-grade safeguards: applicability-domain (AD) gating and green-chemistry awareness.

Z1 closes both gaps. The agent gains a three-signal AD verdict on every recommendation, and a hazard-aware soft-penalty on the final ranking. Both are advisory enrichments — failures degrade gracefully back to Z0 behavior with a banner. Pharma chemists are sophisticated users; the design favors *informing* over *blocking*.

## Design choices (decided during brainstorming)

| Question | Decision | Rationale |
|---|---|---|
| OOD policy | **Annotate, don't block** | Show every recommendation; tag verdict + scores. Withholding information from a chemist is more dangerous than a clearly-labeled OOD prediction. |
| Conformal calibration | **Per-project from in-house mock_eln**, with cross-project bootstrap fallback when project < 30 calibration points | Tighter intervals on familiar chemotypes; matches the per-project pattern already planned for Z3's `mcp_yield_baseline`. |
| Green-chemistry filter | **Soft-penalty in score** | No paternalism; the skill applies a transparent multiplicative penalty (0.40/0.20/0.10/0.05) by worst-class CHEM21 solvent. Chemist sees both unadjusted and adjusted scores. |
| AD compute split | **Builtin queries DB; AD MCP is pure math** | All RLS / DB credentials stay in the agent-claw layer. The new MCP is stateless math + a 30-min calibration cache. |
| Calibration flow | **Server-side cache, two-call protocol** | Builtin POSTs `/calibrate(project_id, residuals)` once per project; MCP returns a `calibration_id`. Subsequent `/assess` calls send only the query + the id. Cache miss → 404 → builtin re-supplies and retries. |

## Architecture

### Two new MCP services (both stateless math/lookup, no DB)

| Service | Port | Purpose | What it does NOT do |
|---|---|---|---|
| `mcp_applicability_domain` | 8017 | Receives DRFP vector + nearest-neighbor distance + (calibration_id or inline residuals). Returns 3-signal verdict (Tanimoto / Mahalanobis / conformal) plus underlying scores. | No DB. No reaction encoding. No yield prediction. |
| `mcp_green_chemistry` | 8019 | Solvent lookup against static CHEM21 / GSK / Pfizer / AZ / Sanofi / ACS GCI-PR JSON tables. Reaction-safety endpoint (RDKit + Bretherick SMARTS). | No filtering. No ranking. No state. |

Both follow the existing chemistry-MCP pattern (`services/mcp_tools/common/app.py` for `/healthz`/`/readyz`/JWT/UID-1001/`no-new-privileges`).

### Two new agent-claw builtins

- **`assess_applicability_domain.ts`** — orchestrates the AD pipeline:
  1. `mcp_drfp /encode` → query DRFP vector
  2. RLS-scoped pgvector lookup for nearest in-house neighbor (mirrors the existing pattern in `services/agent-claw/src/tools/builtins/find_similar_reactions.ts:98`)
  3. RLS-scoped pull of ≤100 calibration `(rxn_smiles, yield_pct)` pairs from the project (bootstrap fallback to all RLS-accessible projects if the project has < 30; abstain entirely if cross-project total < 30)
  4. `mcp_chemprop /predict_yield` over calibration pairs → residuals
  5. `mcp_applicability_domain /calibrate` (returns `calibration_id`, cached 30 min server-side) → `/assess` with the query
  6. Returns `{verdict, tanimoto_signal, mahalanobis_signal, conformal_signal, used_global_fallback}`

- **`score_green_chemistry.ts`** — thin wrapper over `mcp_green_chemistry`, no orchestration logic.

### One skill update — `condition-design` v2

Tools list gains `assess_applicability_domain` and `score_green_chemistry`. Playbook gains:

- After `recommend_conditions` returns top-k, call `assess_applicability_domain` once per *unique reaction* (not per recommendation; for a single Buchwald target, all 5 candidates share the same query reaction so AD is computed once).
- Call `score_green_chemistry` on the union of solvents across the top-k.
- Compute soft-penalty: `final_rank_score = recommender_score × (1 − worst_penalty)` where `worst_penalty` = `max` over the recommendation's solvents of the per-class hazard penalty.
- Re-rank by `final_rank_score`. Show both scores plus the worst solvent class in the rendered table.

## Data flow

```
USER prompt
  ▼
condition-design skill
  1. canonicalize_smiles            → mcp_rdkit
  2. recommend_conditions           → mcp_askcos /recommend_conditions
  3. find_similar_reactions         → mcp_drfp /encode + pgvector (RLS)
  4. assess_applicability_domain    → NEW IN Z1
       ├── mcp_drfp /encode         → query_drfp_vector
       ├── pool.query (RLS)         → nearest_neighbor_distance
       ├── pool.query (RLS)         → calibration_pairs (bootstrap fallback)
       ├── mcp_chemprop /predict_yield → predicted yields → residuals
       ├── mcp_applicability_domain /calibrate (cached) → calibration_id
       └── mcp_applicability_domain /assess → verdict + 3 signals
  5. score_green_chemistry          → NEW IN Z1
       └── mcp_green_chemistry /score_solvents → per-solvent CHEM21 + scores
  6. predict_reaction_yield         → mcp_chemprop /predict_yield (per top-k)
  7. query_kg                       → reagent hazards / incompatibilities
  8. soft-penalty math + final ranking IN THE SKILL
  9. render table to user with all scores + verdict + signals
```

**Calibration cache** ensures the second `assess_applicability_domain` call inside the same turn skips steps 4.b–4.f, going straight to `/assess` with the cached `calibration_id`. The skill calls AD once per unique reaction, not once per recommendation.

**RLS invariant for the bootstrap path.** When a project has < 30 calibration pairs, the builtin's second `pool.query` re-runs *without* the project filter but *still inside the same `withUserContext` transaction* — it relies on the existing `user_project_access` RLS policy to surface only projects the calling user can already see. **No `BYPASSRLS` connection is ever opened from user-facing code**, consistent with the `chemclaw_app` role contract in `db/init/12_security_hardening.sql`. The only place `BYPASSRLS` is used in Z1 is the offline `build_drfp_stats.py` script that produces aggregate (not per-row) Mahalanobis statistics at image-build time.

**Step independence**: Steps 4 + 5 + 6 are independently parallelizable; Z1 ships them sequential. Future optimization can use the harness's `post_tool_batch` hook.

## AD signal definitions

### Signal 1 — Tanimoto-NN in DRFP space

Cosine distance from query to nearest in-house neighbor in `reactions.drfp_vector`.

| Threshold | Predicate |
|---|---|
| `distance ≤ 0.50` (Tanimoto ≥ 0.50) | `in_band = true` |
| `0.50 < distance ≤ 0.70` | borderline contribution |
| `distance > 0.70` (Tanimoto < 0.30) | out-of-band |

Returned: `{distance, tanimoto, threshold_in: 0.50, threshold_out: 0.70, in_band}`.

### Signal 2 — Mahalanobis distance in DRFP feature space

`(x − μ)ᵀ Σ⁻¹ (x − μ)` with diagonal Σ. Stats artifact `drfp_stats_v1.json` shipped in the MCP image:

```json
{ "mean": [2048 floats], "var_diag": [2048 floats],
  "n_train": int, "snapshot_at": ISO-8601,
  "threshold_in": 2150.0, "threshold_out": 2200.0 }
```

Built once at image-build time by an offline script that runs `SELECT drfp_vector FROM reactions` cross-project. This is *aggregate stats*, not per-row data — no leakage. Z1 ships with stats over the seeded mock_eln corpus (~2000 reactions). The artifact is versioned; future refreshes increment `_v1 → _v2`.

Thresholds: chi-square 95th percentile (df=2048) ≈ 2150 (in_band); 99th percentile ≈ 2200 (out-of-band cutoff).

Returned: `{mahalanobis, threshold_in, threshold_out, in_band, stats_version, n_train}`.

### Signal 3 — Conformal-prediction interval width

Inductive (split) conformal regression. Half-width = empirical (1 − α)-quantile of `|true_yield − predicted_yield|` over the per-project calibration set. **α = 0.20 → 80% nominal coverage.**

| Threshold | Predicate |
|---|---|
| `half_width ≤ 30` yield-percentage-points | `in_band = true` |
| `30 < half_width ≤ 50` | borderline |
| `> 50` | out-of-band |

**Bootstrap fallback**: when a project has < 30 calibration pairs after pulling from all RLS-accessible projects, conformal abstains (`half_width = null`, `used_global_fallback = true`); the verdict aggregator excludes it.

Returned: `{alpha: 0.20, half_width, calibration_size, used_global_fallback, threshold_in: 30.0, threshold_out: 50.0, in_band}`.

### Verdict aggregation

```
in_band_count   = (tanimoto.in_band ? 1 : 0)
                + (mahalanobis.in_band ? 1 : 0)
                + (conformal.in_band ? 1 : 0)
usable_signals  = 3 − (conformal_is_null ? 1 : 0)

verdict =
   in_band_count == usable_signals       → 'in_domain'
   in_band_count >= ceil(usable_signals/2) → 'borderline'
   else                                    → 'out_of_domain'
```

In-domain requires all usable signals to agree; borderline requires majority; otherwise out-of-domain. A missing conformal signal can't push the verdict toward `in_domain` — it tightens the threshold. Conservative direction; consistent with annotate-don't-block (verdict is honest, scores remain visible).

## Green-chemistry data model

Static JSON files in `services/mcp_tools/mcp_green_chemistry/data/`:

| File | Contents | Source citation |
|---|---|---|
| `chem21_solvents.json` | ~80 solvents → `{class, score, safety, health, environment}` | Prat et al., *Green Chem.* 2016 |
| `gsk_solvents.json` | GSK ranking, ~60 solvents | GSK guide, public version |
| `pfizer_solvents.json` | Pfizer 4-tier (Preferred/Useable/Undesirable/Avoid) | Alfonsi et al., *Green Chem.* 2008 |
| `az_solvents.json` | AZ guide | Diorazio et al., *Org. Process Res. Dev.* 2016 |
| `sanofi_solvents.json` | Sanofi traffic-light | Prat et al., *Org. Process Res. Dev.* 2013 |
| `acs_gci_pr_unified.json` | ACS GCI-PR cross-vendor unified | Byrne et al., 2016 |
| `bretherick_groups.json` | ~40 hazardous functional-group SMARTS → hazard class | Bretherick's Handbook (subset, public-disclosable patterns only) |

Solvent matching: canonical SMILES first (RDKit-canonicalized), InChIKey fallback, fuzzy name match last (returns `match_confidence: 'name_only'`). Unknown solvents return `match_confidence: 'unmatched'` and null class fields.

**Endpoints**:
- `POST /score_solvents` — input `{solvents: [{smiles?, name?}]}`; output `{results: [{input, canonical_smiles, chem21_class, chem21_score, gsk_score, pfizer_class, az_class, sanofi_class, acs_unified_class, match_confidence}]}`.
- `POST /assess_reaction_safety` — input `{reaction_smiles, solvents}`; output `{pmi_estimate, hazardous_groups, reactant_safety_score, solvent_safety_score, overall_safety_class}`. PMI is `(mass_input − mass_product) / mass_product` from the reaction SMILES + supplied stoichiometry — labeled as estimate.

## Soft-penalty math (in the skill)

```
hazard_penalty_per_solvent = {
   'HighlyHazardous': 0.40,
   'Hazardous':       0.20,
   'Problematic':     0.10,
   'Recommended':     0.00,
   null:              0.05    // unmatched solvents get small uncertainty penalty
}

worst_penalty   = max(hazard_penalty_per_solvent[s.chem21_class] for s in candidate.solvents)
final_rank_score = recommender_score * (1.0 - worst_penalty)
```

Use `max` not `sum`: a Buchwald typically has one primary solvent + maybe one cosolvent; summing would penalize legitimate cosolvent use. Both scores travel into the rendered table; never silently swap one for the other.

The penalty constants live in the skill prompt — chemists can override per-turn ("we have to use DCM for this") and the agent recomputes without the penalty for that turn.

## Schema additions

No new tables. No new projectors. Two new rows in `model_cards`:

1. **`mcp_applicability_domain` / `ad_3signal@v1`**
   - `defined_endpoint`: 3-signal AD verdict over Tanimoto-NN, Mahalanobis, conformal-prediction interval width.
   - `algorithm`: deterministic threshold logic on three independent metrics; details documented in `services/mcp_tools/mcp_applicability_domain/main.py`.
   - `applicability_domain`: self-referential — this *is* the AD definition for downstream models.
   - `predictivity_metrics`: empty for Z1 (Phase Z7 wires `/eval` evaluation).
   - `mechanistic_interpretation`: "Tanimoto reflects nearest-analog availability; Mahalanobis reflects feature-space density; conformal interval reflects yield-model calibrated uncertainty."
   - `trained_on`: "DRFP stats over mock_eln seed (~2000 reactions); per-project conformal calibration over `experiments.yield_pct` (RLS-scoped)."

2. **`mcp_green_chemistry` / `solvent_lookup@v1`**
   - `defined_endpoint`: per-solvent CHEM21 / GSK / Pfizer / AZ / Sanofi / ACS GCI-PR class + reaction-safety estimate.
   - `algorithm`: dictionary lookup keyed on canonical SMILES with InChIKey + fuzzy-name fallback; PMI from `(mass_input − mass_product)/mass_product`; Bretherick SMARTS matching.
   - `applicability_domain`: solvents present in any of the seven shipped guides; unmatched return `match_confidence: 'unmatched'` and null class.
   - `mechanistic_interpretation`: "No mechanistic model — published industry / academic guides curated by their respective authors. PMI is a widely-used pharmaceutical greenness proxy; Bretherick groups encode known thermal / shock / reactive hazards."
   - `trained_on`: cite all seven sources (Prat 2016, GSK guide, Alfonsi 2008, Diorazio 2016, Prat 2013, Byrne 2016, Bretherick subset).

## Error handling

Pattern: **AD and greenness are advisory enrichments, not gates.** A failure in either degrades gracefully to "Z0 behavior + a banner."

| Failure | Behavior |
|---|---|
| `mcp_drfp /encode` fails | Skill bails on AD step; recommender-only output; banner: "AD verdict unavailable — DRFP service down" |
| Pool query for nearest neighbor fails | Same, banner: "AD unavailable — DB unreachable" |
| `<30` calibration pairs cross-project | Conformal abstains (signal=null); verdict over Tanimoto+Mahalanobis only; response: "conformal interval not available — project has insufficient prior data" |
| `mcp_chemprop /predict_yield` on calibration batch fails | Conformal abstains (same path) |
| `mcp_applicability_domain /assess` fails | Skill renders underlying scores anyway; `verdict: 'unknown'` |
| `mcp_green_chemistry /score_solvents` fails | Skill skips soft-penalty (`worst_penalty = 0`); banner: "greenness scoring unavailable" |
| Calibration cache miss on `/assess` (MCP restart, key evicted) | MCP returns 404 with `code: 'calibration_id_unknown'`; builtin re-supplies via `/calibrate` and retries `/assess` once |
| Solvent unmatched in all guides | `match_confidence: 'unmatched'` → 0.05 unmatched-penalty in the soft-penalty math; "unmatched" in the rendered table |

## Testing strategy

### Three test layers

1. **`mcp_applicability_domain` unit tests** (Python, `services/mcp_tools/mcp_applicability_domain/tests/`):
   - `/calibrate` accepts residuals, returns deterministic `calibration_id` (hash of `(project_id, residuals_sorted_tuple)`); cache eviction → 404 on subsequent `/assess`
   - `/assess` math: golden inputs → exact expected Tanimoto verdict, Mahalanobis above/below thresholds, conformal half-width matches empirical quantile
   - Static stats artifact loads on startup; `/readyz` returns 503 when missing
   - Verdict aggregation: 8-case truth table (in/out × 3 signals + abstain combinations)

2. **`mcp_green_chemistry` unit tests** (Python):
   - `/score_solvents` known solvent (DCM → HighlyHazardous, 2-MeTHF → Recommended), unknown solvent (returns null + `match_confidence: 'unmatched'`)
   - `/assess_reaction_safety` PMI calculation on hand-checked reaction
   - Bretherick SMARTS matching: a reaction with an azide reactant flags the right group

3. **Builtin tests** (TypeScript, `services/agent-claw/tests/unit/builtins/`):
   - `assess_applicability_domain.test.ts`: mocks all four downstream calls (mcp_drfp, pool.query × 2, mcp_chemprop, mcp_applicability_domain); verifies orchestration sequence + bootstrap fallback path + cache-miss retry
   - `score_green_chemistry.test.ts`: thin pass-through, mirrors `predict_reaction_yield.test.ts`

### Golden-data fixture

A 5-reaction toy DRFP corpus with hand-computed Mahalanobis values and a 20-row residual table where the 80% quantile is exactly known. Lives in `services/mcp_tools/mcp_applicability_domain/tests/fixtures/`.

### Integration test (deferred to Z7's `/eval`)

Replay a held-out 20% of mock_eln through the Z1 stack; verify the AD verdict distribution matches the expected balance (~70% in-domain, ~25% borderline, ~5% out-of-domain on a coherent corpus). Z1 ships without this; Z7 wires it via the existing `/eval` slash verb.

## Out of scope (explicitly)

- **Web UI for chemists to override CHEM21 classes per organizational policy** → Z6+
- **Per-project calibration refresh on a schedule** → not Z1 (would require a new projector)
- **Multi-fidelity AD combining yield-model UQ with thermo-stability or solubility models** → not Z1
- **Replacing diagonal-Σ Mahalanobis with a learned density estimator (normalizing flow, etc.)** → tracked, not Z1
- **Hard-blocking OOD recommendations or hard-filtering hazardous solvents** → ruled out by the brainstorming decisions; soft enrichments only

## File-level deliverables

### New (created)
- `services/mcp_tools/mcp_applicability_domain/{__init__.py, main.py, requirements.txt, Dockerfile, tests/__init__.py, tests/test_mcp_applicability_domain.py, tests/fixtures/, data/drfp_stats_v1.json, scripts/build_drfp_stats.py}`
- `services/mcp_tools/mcp_green_chemistry/{__init__.py, main.py, requirements.txt, Dockerfile, tests/__init__.py, tests/test_mcp_green_chemistry.py, data/{chem21_solvents,gsk_solvents,pfizer_solvents,az_solvents,sanofi_solvents,acs_gci_pr_unified,bretherick_groups}.json}`
- `services/agent-claw/src/tools/builtins/assess_applicability_domain.ts`
- `services/agent-claw/src/tools/builtins/score_green_chemistry.ts`
- `services/agent-claw/tests/unit/builtins/assess_applicability_domain.test.ts`
- `services/agent-claw/tests/unit/builtins/score_green_chemistry.test.ts`

### Modified
- `services/agent-claw/src/bootstrap/dependencies.ts` — register the two new builtins (config keys `MCP_APPLICABILITY_DOMAIN_URL`, `MCP_GREEN_CHEMISTRY_URL`)
- `services/agent-claw/src/config.ts` — add the two new MCP URL config keys
- `db/seed/05_harness_tools.sql` — INSERT INTO `tools` rows for both builtins
- `db/init/19_reaction_optimization.sql` — INSERT INTO `model_cards` two new rows
- `docker-compose.yml` — register both new services on the `chemistry` profile (UID 1001, `no-new-privileges:true`, healthchecks)
- `infra/helm/` — add the same as Helm values
- `skills/condition-design/SKILL.md` — bump version 1 → 2; extend `tools:` array; rewrite the playbook section to include AD gate + greenness penalty; remove the "What this skill does NOT do (yet)" entries that Z1 closes

### Reused (no modification)
- `services/agent-claw/src/tools/builtins/find_similar_reactions.ts` — same pgvector RLS pattern referenced for the nearest-neighbor query
- `services/agent-claw/src/db/with-user-context.ts` — RLS scoping for the calibration pulls
- `services/agent-claw/src/mcp/postJson.ts` — JWT-minted Bearer-token MCP calls
- `services/mcp_tools/common/app.py` — `create_app` for both new services
- `services/mcp_tools/mcp_chemprop/` — used for residual computation; no changes
- `services/mcp_tools/mcp_drfp/` — used for query encoding; no changes

## Verification (end-to-end)

```bash
# infra
make up.full
make ps

# data
make db.init     # idempotent; new model_cards rows on existing 19_*.sql

# unit
.venv/bin/pytest services/mcp_tools/mcp_applicability_domain/tests/ -v
.venv/bin/pytest services/mcp_tools/mcp_green_chemistry/tests/ -v
cd services/agent-claw && npm test     # builtin unit tests + tsc clean

# integration (manual smoke)
chemclaw chat "What conditions for a Buchwald between 4-bromoanisole and morpholine, project XYZ-001?"
# Expected: top-5 with AD verdict per row, soft-penalty-adjusted score column,
# CHEM21 class column, and (when applicable) "conformal abstain — insufficient
# project data" banner.

chemclaw chat "Score the greenness of DMF vs 2-MeTHF for amide coupling"
# Expected: 2-MeTHF Recommended; DMF Hazardous (or HighlyHazardous depending
# on which guide is consulted); side-by-side comparison.

chemclaw chat "Are these conditions in-domain for our Buchwald model? <SMILES>"
# Expected: 3-signal verdict + raw scores + nearest-analog citation.
```

## Why this design is right

- **Additive only.** No harness change, no hook change, no permission change, no projector, no schema migration beyond two `model_cards` rows.
- **Layered honestly.** AD and greenness are signals the chemist sees; the soft-penalty is a transparent multiplicative adjustment with both numbers visible. Annotate-don't-block puts the chemist in control.
- **Failure-safe.** Every Z1 component degrades to Z0 behavior + a clear banner on failure. No new single-points-of-failure for the recommender path.
- **Auditable.** Every AD verdict is reproducible from `(query DRFP, nearest distance, calibration set, stats artifact version)`. Every greenness score is reproducible from `(canonical solvent SMILES, JSON guide version)`. The `model_cards` rows give the chemist OECD QSAR principle 3 (defined applicability domain) on demand.
