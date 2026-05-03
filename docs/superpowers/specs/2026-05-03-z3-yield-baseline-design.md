# Z3 Design — `mcp_yield_baseline` per-project ensemble + `predict_yield_with_uq` builtin

**Date:** 2026-05-03
**Plan reference:** `~/.claude/plans/develop-an-extensive-plan-distributed-backus.md` (Phase Z3)
**Builds on:** Z0 (PR #64, merged) — independent of Z1 (PR #71) and Z2 (PR #72), which touch disjoint files.

## Context

Z0 ships ASKCOS condition recommendations through `predict_reaction_yield` for sanity-checking. That call hits `mcp-chemprop`, which returns `(mean, std)` from chemprop v2's MVE head — *aleatoric* uncertainty (the noise the model has learned) but no *epistemic* signal (model-class disagreement, "I'm at the edge of training data").

Z3 adds the second signal. A new `mcp_yield_baseline` service combines chemprop with a per-project DRFP+XGBoost model and surfaces both means plus a calibrated ensemble std. Pharma chemists can act on each component differently — high aleatoric → "scale-up the experiment, the noise is real"; high epistemic → "this chemotype is unfamiliar, get more data first." This is the foundation Z5's BoFire optimizer needs for closed-loop yield estimates.

## Design choices (decided during brainstorming)

| Question | Decision |
|---|---|
| Ensemble structure | **Two-model average + disagreement.** `ensemble_mean = avg(chemprop_mean, xgboost_mean)`; `ensemble_std = sqrt(chemprop_std² + ((chemprop_mean - xgboost_mean) / 2)²)`. Two independent signals; aleatoric and epistemic decompose cleanly. Both components surfaced in the response. |
| Model caching | **In-memory LRU + lazy refit.** Cap 32 projects, 30-min TTL. Cold-start = first request after MCP restart pays the fit cost (~1–3 s for 50–10k rows). Stateless across restarts; nothing in the DB to migrate. |
| Cold-start (project < 50 labels) | **Global pretrained XGBoost fallback.** Static artifact `data/xgb_global_v1.json` shipped with the image, trained on USPTO + ORD subset at image build time. Response carries `used_global_fallback: true`. |
| Old `predict_reaction_yield` builtin | **Keep as alias.** New `predict_yield_with_uq` is the recommended one for condition-design and BoFire. Existing Z1 callers (assess_applicability_domain) continue to use the chemprop-only path for calibration residuals — no churn. |
| UQ aggregation | **In the MCP service.** Builtin orchestrates DB + retry; the MCP owns the math. Same separation Z1 set up for `mcp_applicability_domain`. |

## Architecture

### `mcp_yield_baseline` (port 8015)

Stateless math service — no DB, no Postgres credentials. Wraps chemprop and a per-project DRFP+XGBoost model into a single ensemble endpoint.

| Endpoint | Purpose |
|---|---|
| `POST /train` | Accepts `{project_internal_id, training_pairs: [{rxn_smiles, yield_pct}]}`. Refits an XGBoost from DRFP-encoded inputs, caches in LRU keyed by `(project_internal_id, sha256(sorted_pairs))`. Returns `{model_id, n_train}`. Idempotent (same data → same id → cache hit). |
| `POST /predict_yield` | Accepts `{rxn_smiles_list, project_internal_id?, model_id?}`. Returns per-reaction `{ensemble_mean, ensemble_std, components: {chemprop_mean, chemprop_std, xgboost_mean}, used_global_fallback, model_id}`. Returns 412 with `code: "needs_calibration"` when `model_id` is provided but missing from cache (cache eviction or restart). |
| `GET /healthz` | Standard liveness. |
| `GET /readyz` | 503 until `data/xgb_global_v1.json` artifact loads. |

State held by the MCP:
- Global pretrained XGBoost artifact (built once at image-build time; ships with each release).
- In-memory LRU (cap 32 projects) of fitted per-project XGBoost models. 30-min TTL.
- No Postgres connection.

Internals — predict pipeline (per call):

1. Featurize each query reaction via `mcp-drfp /tools/compute_drfp` (note: the correct DRFP endpoint, not `/encode`).
2. **XGBoost prediction**: lookup `(project_internal_id, model_id)` in LRU → predict on DRFP vectors → `xgboost_mean[]`. If `model_id` given but missing → 412. If `used_global_fallback=true` → run the static global XGBoost.
3. **Chemprop prediction**: call `mcp-chemprop /predict_yield(rxn_smiles_list)` → `(chemprop_mean[], chemprop_std[])` from the existing MVE head.
4. **Ensemble combine** (per reaction):
   ```
   ensemble_mean = (chemprop_mean + xgboost_mean) / 2
   disagreement² = ((chemprop_mean - xgboost_mean) / 2)²
   ensemble_std  = sqrt(chemprop_std² + disagreement²)
   ```
5. Return per-reaction full breakdown so consumers can inspect each component.

### `predict_yield_with_uq.ts` builtin

Pulls per-project labeled training data via the existing `withUserContext` RLS pattern, calls `/train` once per turn (cached server-side), then `/predict_yield` for each batch. Cache miss → re-supply via `/train` + retry once.

```sql
SELECT r.rxn_smiles, e.yield_pct
  FROM reactions r
  JOIN experiments e       ON e.id  = r.experiment_id
  JOIN synthetic_steps s   ON s.id  = e.synthetic_step_id
  JOIN nce_projects p      ON p.id  = s.nce_project_id
 WHERE p.internal_id      = $1
   AND e.yield_pct        IS NOT NULL
   AND r.rxn_smiles       IS NOT NULL
 LIMIT 10_000
```

If row count < 50 → set `used_global_fallback = true`, skip `/train`, call `/predict_yield` with `model_id=null`.

### Old `predict_reaction_yield` builtin

Stays as alias. Existing Z1 callers (`assess_applicability_domain` for calibration residuals) keep the chemprop-only path — conformal needs *one* base model, not an ensemble.

### Schema additions — minimal

One new row in the existing `model_cards` table (`db/init/19_reaction_optimization.sql` from Z0). No new tables, no new projectors, no new event types.

```sql
INSERT INTO model_cards (
  service_name, model_version, defined_endpoint, algorithm,
  applicability_domain, predictivity_metrics,
  mechanistic_interpretation, trained_on
) VALUES (
  'mcp_yield_baseline', 'yield_baseline_v1',
  'Per-reaction ensemble yield prediction with calibrated UQ. Returns ensemble_mean + ensemble_std plus chemprop and XGBoost component scores.',
  'Two-model ensemble: chemprop v2 MPNN with MVE head (aleatoric) + per-project XGBoost over DRFP fingerprints (epistemic via disagreement). Global pretrained XGBoost fallback when project has < 50 labels.',
  'Reactions whose DRFP fingerprints fall within the per-project training corpus when used_global_fallback=false; broader USPTO + ORD coverage when used_global_fallback=true.',
  '{"target_ece_global": 0.10, "evaluation_dataset": "Doyle Buchwald-Hartwig HTE (4608 reactions)"}'::jsonb,
  'Aleatoric uncertainty from chemprop MVE head; epistemic from chemprop↔XGBoost disagreement. Components surfaced separately so chemists can act on each (high aleatoric → noise; high epistemic → unfamiliar chemotype).',
  'Per-project: experiments.yield_pct + reactions.rxn_smiles, RLS-scoped. Global fallback: USPTO + ORD subset, snapshot at image-build time.'
)
ON CONFLICT (service_name, model_version) DO NOTHING;
```

## Data flow

```
condition-design / closed-loop-optimization skill
  ▼
predict_yield_with_uq([rxn1...rxn5], project="XYZ-001")
  │
  ├─ withUserContext(pool, userEntraId):
  │     SELECT r.rxn_smiles, e.yield_pct ...               (RLS-scoped)
  │     │
  │     ├─ rows < 50  → used_global_fallback = true; skip /train
  │     └─ rows ≥ 50  → continue
  │
  ├─ POST mcp_yield_baseline /train  (ONCE per turn, cached server-side)
  │     ──► { model_id: "xyz001@<sha>", n_train }
  │
  └─ POST mcp_yield_baseline /predict_yield
        │
        ├─ cache MISS → 412 needs_calibration → re-supply via /train + retry
        │
        ├─ DRFP encode each rxn_smiles via mcp-drfp /tools/compute_drfp
        ├─ XGBoost predict (per-project or global)         → xgboost_mean[]
        ├─ Chemprop predict via mcp-chemprop /predict_yield → (chemprop_mean, chemprop_std)[]
        └─ Combine → return per-reaction {ensemble_mean, ensemble_std, components, ...}
```

Latency:
- Cold (no cache, ≥50 rows): ~3–5 s — DB pull + DRFP encode batch + XGBoost fit + chemprop predict + XGBoost predict.
- Warm (cache hit): ~1–2 s — DRFP encode + chemprop predict + XGBoost predict.

## Error handling

| Failure | Behavior |
|---|---|
| Project < 50 labels | `used_global_fallback = true`; `/train` skipped; global XGB used. |
| `/predict_yield` 412 (cache miss) | Builtin re-trains and retries once. |
| `mcp-chemprop` 5xx | 503 propagated. Skill banner: "yield UQ unavailable". |
| `mcp-drfp` 5xx/4xx | 503 propagated. Same banner. |
| XGBoost training fails (degenerate variance) | 422 `training_failed`; builtin falls back to global. Logged. |
| Global artifact missing at startup | `/readyz` 503; deploy blocked. |
| Cache evicted mid-turn | Re-train + retry; ~1–3 s latency penalty. |
| `chemprop_std == 0` (model lacks MVE head) | `ensemble_std = abs(chemprop_mean - xgboost_mean) / 2`. Degraded but useful. |

## Model serialization — safe by construction

XGBoost's `Booster.save_model("...json")` emits a deterministic JSON representation. **No binary deserialization formats anywhere in the stack.** Per-project models live in process memory; rebuilt from the canonical training data on every cold start. Same posture as Z1's BoFire pivot — source of truth is `experiments.yield_pct`.

`xgboost==2.x` pinned in `requirements.txt`; artifact metadata records the version so future major upgrades trigger re-train rather than mysterious failures.

## Build-time global model

`services/mcp_tools/mcp_yield_baseline/scripts/build_global_xgb.py`:
- Connects as `chemclaw_service` (BYPASSRLS — aggregate cross-project, no per-row leakage).
- Reads `(rxn_smiles, yield_pct)` from `reactions JOIN experiments`.
- DRFP-encodes each pair, fits XGBRegressor (`n_estimators=500, max_depth=6, learning_rate=0.05`, 10% holdout for early stopping).
- Saves `data/xgb_global_v1.json` + `data/xgb_global_v1.meta.json` `{n_train, dataset, snapshot_at, xgboost_version, holdout_rmse}`.
- Synthetic fallback for dev environments without populated data.

## Testing

### Three layers

**Layer 1 — Pure-function unit tests** (`tests/test_ensemble.py`):
- `combine_ensemble({mean: 50, std: 5}, xgb_mean: 60)` → `mean=55, std≈7.07`
- Disagreement of 0 → `ensemble_std == chemprop_std`.
- High-disagreement scaling.
- Per-row mapping over a batch.
- ≥ 8 tests.

**Layer 2 — MCP endpoint tests** (`tests/test_mcp_yield_baseline.py`):
- `/healthz`, `/readyz` (artifact present / missing).
- `/train` deterministic `model_id`; degenerate variance → 422.
- `/predict_yield` cached path; cache-miss → 412.
- `used_global_fallback` path runs without `model_id`.
- Components surfaced in response.
- chemprop + drfp mocked via `httpx.MockTransport`.
- ≥ 12 tests.

**Layer 3 — Builtin tests** (`predict_yield_with_uq.test.ts`):
- Happy path (project has 100 labels) → /train once → ensemble result.
- Bootstrap (5 labels) → no /train → global fallback.
- Cache-miss retry: first /predict_yield 412 → re-train → retry succeeds.
- Empty rxn_smiles_list → Zod rejection.
- ≥ 4 tests, mocked pool + fetch.

### Doyle Buchwald held-out evaluation

`services/mcp_tools/mcp_yield_baseline/scripts/eval_doyle.py`. Replays the open Doyle Buchwald HTE (4608 reactions) through `/predict_yield` against the global pretrained model. Reports RMSE, NLL, ECE for ensemble vs chemprop-alone vs xgboost-alone. **Target: ECE < 0.10.** Z7 wires this into `/eval`.

## Wiring

- `services/agent-claw/src/config.ts`: `MCP_YIELD_BASELINE_URL` (default `http://localhost:8015`).
- `services/agent-claw/src/bootstrap/dependencies.ts`: register `predict_yield_with_uq`.
- `db/seed/05_harness_tools.sql`: tools-table row.
- `db/init/19_reaction_optimization.sql`: append `model_cards` row above.
- `docker-compose.yml`: register `mcp-yield-baseline` on `chemistry` profile.
- `Makefile setup.python`: install new requirements (chemprop is NOT installed in dev .venv — same Z0 pattern; only installed inside Docker).

## Out of scope

- Active learning / batch BO selection — Z5 (BoFire).
- Per-project model auto-refresh on `experiment_imported` — would need a new projector. 30-min TTL covers staleness.
- > 2 ensemble components — YAGNI.
- Model versioning / staged rollout — Phase E `shadow_until` mechanism.

## Verification

```bash
make up.full
make ps                            # mcp-yield-baseline healthy
.venv/bin/pytest services/mcp_tools/mcp_yield_baseline/tests/ -v
cd services/agent-claw && npm test
chemclaw chat "Predict yield with uncertainty for ... in project XYZ-001"
# Expected: ensemble_mean ± ensemble_std; components shown; used_global_fallback flag.

# Doyle Buchwald eval (manual, post-deploy)
.venv/bin/python services/mcp_tools/mcp_yield_baseline/scripts/eval_doyle.py
# Expected: ECE < 0.10 on global model.
```

## Why this is the right design

- **Additive only.** New MCP, new builtin, one model_cards row. No harness, hook, permission, schema, or projector changes. PR doesn't conflict with Z1, Z2, or main.
- **Layered honestly.** Aleatoric + epistemic decomposition gives chemists actionable signals; both component scores travel into the response so the ensemble is auditable.
- **Cost-bounded.** Global fallback covers cold-start projects from day one; per-project model fits in seconds; LRU+TTL keeps memory bounded.
- **Forward-compatible.** Z5's BoFire optimizer reads `predict_yield_with_uq` as its yield surrogate. Z7's `/eval` slots in via the existing `eval_doyle.py` script.
- **Safe by construction.** XGBoost JSON serialization only (no binary deserialization formats); all RLS in the builtin (no DB credentials in MCP); chemprop std=0 degenerate case has a graceful path.
