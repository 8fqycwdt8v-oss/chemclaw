# Python MCP Services Quality Audit — 2026-05-03

**Reviewer:** code-quality (read-only)
**Scope:** `services/mcp_tools/` — 22 in-scope services + `common/` shared
infrastructure (`mcp_instrument_template/` is a docs-only scaffold, not a
runnable service; excluded). Total Python LOC: ~21,500 across all services
and tests.
**Cross-reference:** `docs/review/2026-04-29-codebase-audit/02-python-hotspots.md`.
That audit covered three "god files" (`mock_eln/seed/generator.py`,
`mcp_eln_local/main.py`, `mcp_doc_fetcher/main.py`) at depth. The eln_local
and doc_fetcher splits called for in PR-7 have landed; this review extends
the lens across the rest of the fleet and the recently merged churn
(`mcp_xtb` workflow engine, Z1/Z3/Z4/Z5 services, `mcp_synthegy_mech`,
`mcp_eln_local`, `mcp_logs_sciy`).

The factory at `services/mcp_tools/common/app.py` is in good shape: every
service except `mcp_instrument_template` (docs scaffold) routes through
`create_app(...)`, gets the `/healthz`/`/readyz` pair, the
`ValueError → 400` exception handler, the request-ID middleware, the
fail-closed `mcp_auth_middleware` (Phase-7 enforcement), and the
catalog-omission startup guard. Bearer-token auth, scope binding, and
`aud`-claim enforcement are wired identically everywhere. **There are no
hand-rolled FastAPI apps**, despite an earlier grep miss that suggested
otherwise (concern #1, #6).

The dominant systemic issue is the **`async def` ⇒ blocking-work
mismatch**. Eleven services declare handlers `async def` but call
synchronous, often heavy, work (RDKit, subprocess, sync httpx, sync
psycopg, model load, file IO) directly. Only `mcp_synthegy_mech`,
`mcp_yield_baseline`, and `mcp_xtb`'s new workflow path get this right
via `asyncio.to_thread` / `anyio.to_thread.run_sync`. Under sustained
load this serialises every request on the single-thread event loop and
blocks every other in-flight call (including `/healthz`).

The second systemic issue is **per-request reconstruction of expensive
objects**: aizynth's `AiZynthFinder`, askcos's `AskCOSClient`, chemprop's
`MPNN.load_from_file`, green-chemistry's `Chem.MolFromSmarts(...)` for
every Bretherick group, ord_io's `from ord_schema.proto import ...`,
genchem's `psycopg.connect(...)`, and tabicl's `load(pca_path)` all
happen *inside the route handler*. The fix in each case is the same —
build the resource once in the lifespan and capture it in module-level
state — and the cost in per-request latency and CPU is significant.

The third systemic issue is **cosmetic-rather-than-real `/readyz`
implementations**: aizynth/askcos/chemprop check that a model directory
*exists* (not that the artifact actually loads), eln_local checks only
the `mock_eln_enabled` feature flag (not pool health), drfp/rdkit/kg
have no ready_check at all, and embedder declares ready before the
sentence-transformer model is downloaded. Kubernetes flips a service
into rotation and discovers it can't actually serve, often in the
agent's hot path.

The newly merged `mcp_xtb` workflow path (commit `c72dd92`) is high
quality: `asyncio.create_subprocess_exec` with hard timeouts,
`TaskGroup`-based bounded concurrency, validate-inputs synthetic step,
total-vs-step timeout decomposition. **However** the migration of
`/conformer_ensemble` to the workflow engine is documented in
`recipes/optimize_ensemble.py:11–14` as introducing a non-backwards-
compatible numerical change: weights are now derived from POST-opt xtb
energies (not CREST's pre-opt comment-line ones) and the partition
function uses `RT(298.15 K) ≈ 0.5925 kcal/mol` rather than the legacy
`RT = 1 kcal/mol`. The docstring is honest, but **callers depending on
the old weights will see different numbers from the same SMILES** with
no version-bump on the route. The `OptimizeGeometryOut.optimized_xyz`
shape did not change — only `ConformerEnsembleOut[i].weight` and
`energy_hartree`. This is the only meaningful behavioural diff in the
workflow-engine routing.

`mcp_synthegy_mech` is the architectural reference for "an MCP that
calls another MCP": it canonicalises SMILES via `asyncio.to_thread`,
runs the entire search inside `asyncio.wait_for` with a 270s server-
side cap (30s under the agent's `TIMEOUT_SYNTHEGY_MECH_MS`), uses
`httpx.AsyncClient` for outbound calls, and strips Synthegy's prompt-
delimiter XML tags from user-supplied free text before concatenation.
Cancellation propagates cleanly through both LiteLLM and the xtb
validator. New chemistry-tool services should be measured against this
file.

Two policy gaps remain: (1) the `services/_constraints.txt` file is
referenced by only 2 of 23 services (`common/`, `mcp_tabicl`); the
other 21 declare their own bare-floor `>=` pins per requirements file,
which is exactly the version-skew surface the constraints file was
written to close. (2) Four services have **zero tests** anywhere
(`mcp_drfp`, `mcp_embedder`, `mcp_kg`, and `mcp_rdkit`); these are
foundational call-sites for every retrieval and reaction-search
workflow. The PR-7 audit also noted the `MolFromSmiles → if mol is
None: raise ValueError` pattern is duplicated across multiple call
sites (`mcp_rdkit/main.py:67–73`, `mcp_xtb/_shared.py:96–98`,
`mcp_aizynth/main.py:88–89`, `mcp_askcos/main.py:97–98`,
`mcp_chemprop/main.py` (no validation at all),
`mcp_genchem/main.py:85–87`, `mcp_green_chemistry/main.py:91–94`,
`mcp_synthegy_mech/main.py:218–224`, `mcp_crest/main.py:69–71`); a
shared `services/mcp_tools/common/chemistry.py` is still missing. The
chemprop case is the worst — there is *no* RDKit validation before
pushing into chemprop's loader, so an invalid SMILES surfaces as a
chemprop traceback rather than a 400 with a specific reason.

## Executive Summary

| Severity | Finding | Service | File:line | Fix sketch |
|---|---|---|---|---|
| Critical | `async def` handlers do blocking xTB subprocess work without `to_thread`, blocking the event loop for the entire xtb wall-clock (up to 300s) | mcp_xtb | `mcp_xtb/main.py:158, 220, 287, 422, 507, 656, 732, 787, 852, 929`; `mcp_xtb/_shared.py:124–132` (sync `subprocess.run`) | Either swap legacy single-shot endpoints to `asyncio.create_subprocess_exec` (already used by `workflow.run_subprocess`), or wrap each `_run_xtb` call in `await asyncio.to_thread(...)`. The new workflow engine is the model. |
| Critical | Same pattern for CREST | mcp_crest | `mcp_crest/main.py:282, 287, 292` (async handlers call sync `_run_crest_task`); `mcp_crest/main.py:91–96` (sync `subprocess.run`) | Mirror the xtb fix: switch to `asyncio.create_subprocess_exec` or wrap with `to_thread`. |
| Critical | Same pattern for SIRIUS | mcp_sirius | `mcp_sirius/main.py:166–196` (`async def identify` calls sync `_run_sirius`); `mcp_sirius/main.py:54–63` | Same fix. |
| Critical | `mcp_chemprop.predict_yield` reloads a torch MPNN model from disk on **every request** inside an async handler | mcp_chemprop | `mcp_chemprop/main.py:55–80, 121, 165` | Load all models once at lifespan startup, cache them on a module-level holder, and run inference via `await asyncio.to_thread(...)`. |
| Critical | `mcp_aizynth.retrosynthesis` rebuilds an `AiZynthFinder` (config + policy networks) on every request inside an async handler | mcp_aizynth | `mcp_aizynth/main.py:49–61, 91` | Build the finder once in lifespan; per-request, only mutate `target_smiles` / `iteration_limit` / `stock.select`. |
| Critical | `mcp_askcos.retrosynthesis/forward_prediction/recommend_conditions` rebuild `AskCOSClient()` on every request | mcp_askcos | `mcp_askcos/main.py:52–64, 100, 153, 250` | Build the client once in lifespan, store on a holder dict (mirror the kg / eln_local pattern). |
| Critical | `mcp_genchem._record_run` opens a fresh blocking `psycopg.connect` per request inside async handlers | mcp_genchem | `mcp_genchem/main.py:118–155` (sync); called from `scaffold_decorate` line 241, and the sibling enumerate / mmp / bioisostere / fragment endpoints | Switch to `psycopg-pool` async pool, mirror `mcp_eln_local`'s `_acquire`; or at minimum run via `to_thread`. |
| Critical | `mcp_logs_sciy.FakePostgresBackend` opens a fresh `AsyncConnection` per call instead of using a pool | mcp_logs_sciy | `mcp_logs_sciy/backends/fake_postgres.py:104–113, 210, 218` | Use `psycopg_pool.AsyncConnectionPool` with the same lifespan pattern as `mcp_eln_local/main.py:105–127`. |
| Critical | `mcp_chemprop` does **not** validate SMILES via RDKit before pushing into chemprop — invalid input surfaces as a chemprop traceback (500) instead of a 400 | mcp_chemprop | `mcp_chemprop/main.py:111–132, 156–171` | Re-use the shared `_mol_from_smiles` helper (proposed `common/chemistry.py`); pre-validate every entry. |
| High | `/conformer_ensemble` numerical-output change is silently behaviour-incompatible: weights now from POST-opt xtb energies and `RT = 0.5925 kcal/mol` instead of legacy `RT ≈ 1 kcal/mol` | mcp_xtb | `mcp_xtb/recipes/optimize_ensemble.py:11–14, 110–124`; called from `mcp_xtb/main.py:969–994` | Either bump the route version (`/v2/conformer_ensemble`) or expose a `legacy_weights: bool = False` flag. Document the diff in the agent-claw side too — a CHANGELOG entry against `services/agent-claw/src/tools/builtins/conformer_ensemble.ts`. |
| High | `mcp_doc_fetcher.fetch` uses sync `httpx.Client` from inside async handlers (sibling of yield_baseline which fixes this with `anyio.to_thread`) | mcp_doc_fetcher | `mcp_doc_fetcher/fetchers.py:118` (`with httpx.Client(...) as client`); routes call this from `mcp_doc_fetcher/main.py:80, 104, 125` async handlers | Either wrap each fetch_https call in `await anyio.to_thread.run_sync(...)`, or rewrite `fetchers.py` to use `httpx.AsyncClient`. |
| High | `mcp_kg` has no `ready_check` despite owning the bi-temporal KG; `/readyz` always returns 200 even when Neo4j is unreachable | mcp_kg | `mcp_kg/main.py:78–88` (`# create_app() expects a sync ready_check returning bool`) | Cache the last `verify()` result with a TTL; expose a sync `_is_ready()` that returns it, and pass it to `create_app(ready_check=...)`. |
| High | `mcp_eln_local._ready_check` returns True whenever `mock_eln_enabled=True` regardless of pool health; lifespan logs a warning but doesn't block | mcp_eln_local | `mcp_eln_local/main.py:118–122, 130–132` | Track pool open/closed state in a module variable; gate `_ready_check` on it. |
| High | `mcp_drfp.compute_drfp` is `async def` calling sync `DrfpEncoder.encode` (per-call ~50–500 ms on real molecules) | mcp_drfp | `mcp_drfp/main.py:62–71` | `await asyncio.to_thread(DrfpEncoder.encode, [req.rxn_smiles], ...)`. Add `ready_check` that imports `drfp` and returns True if the encoder is constructable. |
| High | `mcp_embedder.embed_text` triggers a synchronous sentence-transformers download on the first call inside an async handler — multi-minute event-loop block on cold start | mcp_embedder | `mcp_embedder/main.py:54–70`; encoder load at `mcp_embedder/encoder.py:41–51, 53` | Eager-load the model in lifespan (warm before /readyz returns ok); subsequent encode calls go through `to_thread`. |
| High | `mcp_rdkit.bulk_substructure_search` iterates up to 5000 sync RDKit `MolFromSmiles + GetSubstructMatches` calls inside an async handler | mcp_rdkit | `mcp_rdkit/main.py:288–311` | Run the entire scan via `await asyncio.to_thread(...)`; the inner code is pure-CPU and benefits from threadpool offload. |
| High | `mcp_green_chemistry._scan_bretherick` re-parses every Bretherick SMARTS via `Chem.MolFromSmarts` for every reactant of every request | mcp_green_chemistry | `mcp_green_chemistry/main.py:291–312` (the `for group in _BRETHERICK_GROUPS: patt = Chem.MolFromSmarts(...)` inner loop) | Pre-compile patterns once in `_lifespan` and store them on `_BRETHERICK_GROUPS[i]["pattern"]`. |
| High | `mcp_ord_io` re-imports `ord_schema.proto` on **every** `/export` and `/import` request despite being a hard requirement | mcp_ord_io | `mcp_ord_io/main.py:88–91, 139–142` | Move the import to module top, surrounded by `try/except ImportError` so the service still starts (and fails ready) when ord_schema is missing. |
| High | `mcp_doc_fetcher` declares no `ready_check` despite shipping a hard `pypdf` dependency; `/readyz` always 200 | mcp_doc_fetcher | `mcp_doc_fetcher/main.py:57–62` | Add a `_ready` that returns `True` iff `import pypdf` succeeds. |
| High | `services/_constraints.txt` is consumed by only 2 of 23 services (the original PR-7 fix W2.18 has bit-rotted) | all | `services/mcp_tools/common/requirements.txt:1`, `services/mcp_tools/mcp_tabicl/requirements.txt` are the only consumers | Add `-c ../../_constraints.txt` to the top of every other `services/mcp_tools/mcp_*/requirements.txt`. |
| High | `mcp_drfp`, `mcp_embedder`, `mcp_kg`, `mcp_rdkit` have **zero** tests anywhere | mcp_drfp / mcp_embedder / mcp_kg / mcp_rdkit | n/a | Add at least one happy-path + one bad-input test per endpoint per service. |
| Medium | `MolFromSmiles → if mol is None: raise ValueError(...)` pattern duplicated across 8 services, each with a slightly different error message | crest, xtb, aizynth, askcos, chemprop (missing!), genchem, green_chemistry, synthegy_mech | `mcp_rdkit/main.py:67–73`, `mcp_xtb/_shared.py:96–98`, `mcp_aizynth/main.py:88–89`, `mcp_askcos/main.py:97–98`, `mcp_genchem/main.py:85–87`, `mcp_green_chemistry/main.py:91–94`, `mcp_synthegy_mech/main.py:218–224`, `mcp_crest/main.py:67–71` | Land `services/mcp_tools/common/chemistry.py` exporting `mol_from_smiles(smiles, *, max_len=MAX_SMILES_LEN) -> Mol` and migrate all call sites. PR-7 audit recommended this — still not landed. |
| Medium | `mcp_plate_designer` shadows the `create_app` `ValueError → 400` handler with its own `except ValueError` magic-string match against `_designer.design_plate` errors, mapping to 422 | mcp_plate_designer | `mcp_plate_designer/main.py:120–141` | Use typed exceptions in `_designer` (define `EmptyCategoricalError`, `UnknownPlateFormatError`, etc.); catch the typed types and map to status codes without string matching. |
| Medium | `mcp_genchem._record_run` swallows all DB errors as a warning and returns `run_id=None`; the route succeeds and the caller has no signal that persistence failed | mcp_genchem | `mcp_genchem/main.py:118–155` (the bare `except Exception as exc: log.warning(...)`) | Either fail the route (the user should know their generated set wasn't persisted) or expose `persistence_status: 'ok' | 'failed'` in `GenRunOut`. |
| Medium | `mcp_drfp.compute_drfp` swallows all encoder errors as a generic `ValueError(...)` instead of distinguishing transport/input/internal failures | mcp_drfp | `mcp_drfp/main.py:62–71, 73–74` | At least preserve the original exception class name in the message; better, raise different `ValueError` for bad-input vs internal. |
| Medium | `mcp_aizynth.retrosynthesis` accepts `req.stocks: list[str]` and calls `finder.stock.select(stock_name)` for each without validating against an allowlist | mcp_aizynth | `mcp_aizynth/main.py:77, 93–95` | Define `ALLOWED_STOCKS` constant; validate via Pydantic `Literal` or a `field_validator`. |
| Medium | `mcp_logs_sciy.LogsSettings._ready_check` returns True for the fake-postgres backend without ever connecting; transient pool failures silently pass /readyz | mcp_logs_sciy | `mcp_logs_sciy/main.py:307–315`; `backends/fake_postgres.py:115–124` exposes a real `async def ready()` that's never wired to `/readyz` | Plumb `_backend().ready()` into a lazy sync wrapper (cache result with a 30s TTL) and pass it as the `ready_check`. |
| Medium | `mcp_reaction_optimizer.recommend_next` runs sync BoFire BO inside an async handler (real-world latency: seconds-to-minutes for non-trivial campaigns) | mcp_reaction_optimizer | `mcp_reaction_optimizer/main.py:173–203` | Wrap `_opt.recommend_next_batch(...)` in `await asyncio.to_thread(...)`. Same for `extract_pareto`. |
| Medium | `mcp_reaction_optimizer._build_bofire_domain` re-imports bofire on every request (BoFire is a hard dep, not optional) | mcp_reaction_optimizer | `mcp_reaction_optimizer/main.py:90–96, 142–143` | Move `from bofire.data_models...` to module top. |
| Medium | `mcp_tabicl._predict / _featurize` reload PCA from disk on every call via `_require_pca() → load(pca_path)` | mcp_tabicl | `mcp_tabicl/main.py:96–99, 103, 145` | Cache the `FittedPca` in lifespan; invalidate via `/pca_refit`. |
| Medium | `mcp_tabicl._pca_refit` adds a parallel admin-token mechanism (`x-admin-token` header) on top of the standard JWT auth — duplicate auth surface | mcp_tabicl | `mcp_tabicl/main.py:160–174` | Either retire the `MCP_TABICL_ADMIN_TOKEN` and require a JWT scope (`mcp_tabicl:admin`), or document why a separate token is needed. The `compare_digest` use itself is correct. |
| Medium | `mcp_embedder` instantiates the encoder at **module import time** (line 35); a slow load or model-download timeout prevents the worker from binding the port | mcp_embedder | `mcp_embedder/main.py:28–35` | Move encoder construction into the lifespan; bind the port first, hydrate after. |
| Medium | `mcp_drfp` has no `ready_check` despite a hard runtime dependency on the `drfp` package | mcp_drfp | `mcp_drfp/main.py:27–32` | Add a `_ready_check` that imports `drfp` (which the route does anyway) and returns True. |
| Medium | `mcp_rdkit` has no `ready_check` | mcp_rdkit | `mcp_rdkit/main.py:56–61` | Add `_ready_check` returning True iff `import rdkit` succeeds. |
| Medium | `mcp_eln_local._lifespan` swallows `pool.open` failure as a warning and continues yielding (line 119–122). The pool stays absent and every request returns 503 — but readyz reports OK | mcp_eln_local | `mcp_eln_local/main.py:118–122` | Either re-raise the exception (fail-closed), or set a flag that ready_check inspects. |
| Medium | `mcp_doc_fetcher` re-raises generic `Exception` as `ValueError(f"fetch failed: {exc}")` which surfaces httpx and pypdf details into the response body — including URLs that may carry session tokens | mcp_doc_fetcher | `mcp_doc_fetcher/main.py:91–95, 113–115, 140–142` | Log `exc` server-side via the existing logger; return a generic message client-side. Mirrors the redaction discipline `mcp_yield_baseline` already practices at lines 167, 284, 291. |
| Medium | `mcp_yield_baseline` has no per-request `ready_check` for the global XGB artifact load: if `_load_global_xgb()` raises, the global is None and `_is_ready()` returns False — but if the file *exists* and `xgb.Booster.load_model` raises, the lifespan crashes the whole app | mcp_yield_baseline | `mcp_yield_baseline/main.py:40–62` | Guard `booster.load_model(...)` with try/except in `_load_global_xgb`; log and return None on failure. |
| Low | `_DEV_SENTINEL_PASSWORD` guard duplicated across `mcp_eln_local` and `mcp_logs_sciy` (each with their own `_check_dsn_safety`) | mcp_eln_local, mcp_logs_sciy | `mcp_eln_local/main.py:90–102`, `mcp_logs_sciy/main.py:259–272` | Lift the helper to `services/mcp_tools/common/dsn_safety.py: assert_no_dev_sentinel_in_dsn(dsn, sentinel, opt_out_env_var)`. |
| Low | The `_lifespan` factory pattern (pool holder, `_acquire` dependency context manager) is duplicated between `mcp_eln_local`, `mcp_logs_sciy`, `mcp_kg` (driver holder); could become `common/db_pool.py: make_pool_lifespan(name, dsn, ...)` | all DB-coupled MCPs | `mcp_eln_local/main.py:87–127`, `mcp_logs_sciy/main.py:247–297`, `mcp_kg/main.py:35–69` | Lift the holder + lifespan + acquire triple. |
| Low | RDKit `Chem.MolFromSmarts` validation in `mcp_rdkit.substructure_match` and `bulk_substructure_search` checks `query is None` and raises `ValueError`, but does not bound iteration length on `target.GetSubstructMatches` for pathological queries | mcp_rdkit | `mcp_rdkit/main.py:242–252, 288–311` | Cap `len(matches)` in the result; use `maxMatches` parameter in `GetSubstructMatches` (RDKit ≥ 2023.09 supports this). |
| Low | `_CALIBRATION_CACHE` in `mcp_applicability_domain` is per-process; multi-worker uvicorn deployments hit cold caches on whichever worker handles the second request | mcp_applicability_domain | `mcp_applicability_domain/main.py:75–96` | Either run with `--workers 1` (already implicit for stateful caches like this) and document; or back the cache with Redis if scale becomes an issue. |
| Low | `_acquire` `HTTPException` branch in `mcp_eln_local` re-raises with `f"mock_eln DB unavailable: {exc}"` — the exception's `str(exc)` may contain DSN fragments depending on psycopg version | mcp_eln_local | `mcp_eln_local/main.py:155–159` | Log the full exception server-side; return a generic detail to clients. |

## Per-service Scorecard

`mcp_instrument_template/` is a documentation-only scaffold with no
`main.py`, so it is excluded.

| Service | LOC (main.py) | Uses `common.create_app` | Pydantic-validates input | Tests | Dockerfile UID 1001 | Healthcheck quality | Async-correct (no event-loop block) |
|---|---:|---|---|---:|---|---|---|
| mcp_aizynth | 124 | yes | yes | 1 | yes | weak (config file existence only) | NO (sync ML inference per request) |
| mcp_applicability_domain | 299 | yes | yes | 1 | yes | yes (gates on artifact load) | yes (numpy is fast enough) |
| mcp_askcos | 290 | yes | yes | 1 | yes | weak (model-dir existence only) | NO (sync inference, client per req) |
| mcp_chemprop | 182 | yes | yes (no SMILES validation) | 1 | yes | weak (model-dir existence only) | NO (model load per req) |
| mcp_crest | 307 | yes | yes | 1 | yes | yes (`shutil.which("crest")`) | NO (sync subprocess.run in async) |
| mcp_doc_fetcher | 181 | yes | n/a (validators in submodule) | 0 (repo-level only) | yes | NO (none) | NO (sync httpx in async) |
| mcp_drfp | 92 | yes | yes | 0 | yes | NO (none) | NO (sync DrfpEncoder in async) |
| mcp_eln_local | 185 | yes | yes (in models.py) | 1 | yes | weak (flag-only, not pool) | yes (psycopg async pool) |
| mcp_embedder | 81 | yes | yes (in models.py) | 0 | yes | weak (declared ready before model load) | NO (sync encoder, model dl in route) |
| mcp_genchem | 687 | yes | yes | 2 | yes | weak (rdkit-import only) | NO (sync RDKit + sync psycopg.connect per request) |
| mcp_green_chemistry | 395 | yes | yes | 1 | yes | weak (data-dir existence only) | NO (sync RDKit, SMARTS re-parse per req) |
| mcp_kg | 131 | yes | yes (in models.py) | 0 | yes | NO (none — driver verify never wired to /readyz) | yes (Neo4j async driver) |
| mcp_logs_sciy | 386 | yes | yes (with regex validators) | 1 | yes | weak (backend.ready not wired) | yes (async psycopg, no pool) |
| mcp_ord_io | 195 | yes | yes | 1 | yes | yes (`ord_schema` import probe) | yes (no IO/heavy work in handler) |
| mcp_plate_designer | 153 | yes | yes (with field validators) | 1 | yes | weak (data-file existence only) | NO (sync BoFire DoE) |
| mcp_rdkit | 347 | yes | yes | 0 | yes | NO (none) | NO (5000-element bulk loop in async) |
| mcp_reaction_optimizer | 251 | yes | yes | 2 | yes | yes (bofire import probe) | NO (sync BoFire BO) |
| mcp_sirius | 207 | yes | yes | 1 | yes | yes (`shutil.which("sirius")`) | NO (sync subprocess.run in async) |
| mcp_synthegy_mech | 391 | yes | yes (model + canonical SMILES, prompt-tag stripping) | 2 | yes | yes (rdkit import + stub policy) | YES (asyncio.wait_for + to_thread + AsyncClient) |
| mcp_tabicl | 180 | yes | yes | 0 (repo-level only) | yes | yes (gates on PCA artifact) | yes (sync handlers, FastAPI runs in threadpool) |
| mcp_xtb | 1045 | yes | yes | 5 | yes | yes (`shutil.which("xtb")`) | mixed: workflow path YES, legacy single-shot NO |
| mcp_yield_baseline | 325 | yes | yes (per-element bound) | 4 | yes | yes (gates on global model) | YES (anyio.to_thread.run_sync) |

Sum: 22 services, all use `common.create_app`. Test gaps: 4 services with zero
tests. Async-correct: 5 of 22 (synthegy_mech, tabicl, yield_baseline,
applicability_domain, ord_io); the workflow-engine path of mcp_xtb counts as a
sixth for the `/conformer_ensemble` and `/run_workflow` endpoints, but the
remaining ~14 single-shot xtb endpoints share the legacy blocking pattern.

## Refactor Catalog (Full Appendix)

This appendix expands every Executive-Summary row with concrete evidence.

### CRIT-1 — `async def` xtb single-shot endpoints block the event loop

Severity: Critical
Service: `mcp_xtb`
Files: `services/mcp_tools/mcp_xtb/main.py:158, 220, 287, 422, 507, 656,
732, 787, 852, 929`; helper `services/mcp_tools/mcp_xtb/_shared.py:124–132`.

Evidence:

```python
# _shared.py:124–132
def run_xtb(args: list[str], cwd: Path, timeout: int = XTB_TIMEOUT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=timeout,
        shell=False,
    )
```

```python
# main.py:157–202 (single_point) — async handler that calls sync run_xtb
@app.post("/single_point", response_model=SinglePointOut, tags=["xtb"])
async def single_point(req: Annotated[QmReqBase, Body(...)]) -> SinglePointOut:
    canonical, xyz, inchikey = _smiles_to_canonical_and_xyz(req.smiles)  # sync RDKit
    ...
    with tempfile.TemporaryDirectory() as tmp:
        ...
        result = _run_xtb(args, tmp_path)  # blocks event loop for ≤ 120s
```

Same pattern at:

- `geometry_opt` (line 220, sync run + sync read_text on `xtbopt.xyz`)
- `frequencies` (line 287, `_run_xtb(..., timeout=300)`)
- `relaxed_scan` (line 422, sync subprocess + sync `_parse_scan_log` reading `xtbscan.log`)
- `md` (line 507, `timeout=300`)
- `excited_states` (line 656, **two** sync subprocess calls back-to-back)
- `fukui` (line 732)
- `charges` (line 787)
- `redox` (line 852, sync IPEA subprocess)
- `optimize_geometry` (legacy compat at line 929)

Workflow-routed path (`/conformer_ensemble`, `/run_workflow`) is fine —
those go through `services/mcp_tools/mcp_xtb/workflow.py:45–72` which uses
`asyncio.create_subprocess_exec` correctly. The fix for the single-shot
endpoints is the same: replace `_run_xtb` with `await
workflow.run_subprocess(...)`, or wrap each call in `await
asyncio.to_thread(...)`. The cache-lookup `qm_lookup` and `qm_store` calls
are also sync DB ops and need the same wrap.

### CRIT-2 — `mcp_crest` blocks the event loop

Severity: Critical
Service: `mcp_crest`
Files: `services/mcp_tools/mcp_crest/main.py:91–96, 212–278, 282, 287, 292`.

Evidence:

```python
# crest/main.py:281–296
@app.post("/conformers", ...)
async def conformers(req: Annotated[CrestReqBase, Body(...)]) -> EnsembleOut:
    return _run_crest_task(req, task="conformers", extra_flags=["--niceprint"])
```

`_run_crest_task` (line 212) calls `_run_crest` (line 91, sync
`subprocess.run` with timeout 600s). CREST is the slowest of the chemistry
binaries; blocking the event loop for up to ten minutes per call is severe.

Fix: same as CRIT-1.

### CRIT-3 — `mcp_sirius` blocks the event loop

Severity: Critical
Service: `mcp_sirius`
Files: `services/mcp_tools/mcp_sirius/main.py:54–63, 165–196`.

Evidence: identical pattern. `async def identify` (line 166) calls sync
`_run_sirius` (line 54). 120s blocking ceiling.

### CRIT-4 — `mcp_chemprop` reloads MPNN model on every request

Severity: Critical
Service: `mcp_chemprop`
Files: `services/mcp_tools/mcp_chemprop/main.py:55–80, 121, 165`.

Evidence:

```python
# main.py:55–80
def _chemprop_predict(smiles_list: list[str], model_path: Path) -> list[tuple[float, float]]:
    ...
    model = MPNN.load_from_file(str(model_path))   # ← reloaded every request
    dataset = cp_data.MoleculeDataset([cp_data.MoleculeDatapoint.from_smi(smi) for smi in smiles_list])
    loader = cp_data.build_dataloader(dataset, shuffle=False)
    preds_list: list[torch.Tensor] = []
    with torch.no_grad():
        for batch in loader:
            preds_list.append(model(batch.bmg, batch.V_d, batch.X_d, batch.Y))
```

`MPNN.load_from_file` deserialises a torch model from disk; on a typical
chemprop yield model that's hundreds of MB and several seconds. Plus the
function is sync inside `async def predict_yield` / `predict_property`.

Fix: load each model once in lifespan into a `dict[str, MPNN]`, pass into
`_chemprop_predict(model, smiles_list)`, and wrap the predict call in
`asyncio.to_thread`.

### CRIT-5 — `mcp_aizynth` rebuilds AiZynthFinder on every request

Severity: Critical
Service: `mcp_aizynth`
Files: `services/mcp_tools/mcp_aizynth/main.py:49–61, 85–113`.

Evidence: line 91, `finder = _get_finder(_CONFIG_PATH)` is called in the
route. `_get_finder` instantiates `AiZynthFinder(configfile=str(config_path))`
which reads the config YAML, loads the policy networks, and builds a
template library — a multi-second operation per request.

Fix: move construction into lifespan. Per-request mutate
`finder.target_smiles`, `finder.config.iteration_limit`, and
`finder.stock.select(...)`.

### CRIT-6 — `mcp_askcos` rebuilds client every request

Severity: Critical
Service: `mcp_askcos`
Files: `services/mcp_tools/mcp_askcos/main.py:52–64, 100, 153, 250`.

Same pattern as aizynth.

### CRIT-7 — `mcp_genchem` opens a fresh sync psycopg connection per request

Severity: Critical
Service: `mcp_genchem`
Files: `services/mcp_tools/mcp_genchem/main.py:118–155`.

Evidence:

```python
# main.py:118–155
def _record_run(*, kind, seed_smiles, params, proposals, requested_by=None) -> str | None:
    run_id = str(uuid.uuid4())
    try:
        with psycopg.connect(_get_pool_dsn()) as conn, conn.cursor() as cur:
            cur.execute("""INSERT INTO gen_runs ...""", (...))
            for p in proposals:
                cur.execute("""INSERT INTO gen_proposals ... ON CONFLICT (run_id, inchikey) DO NOTHING""", (...))
        return run_id
    except Exception as exc:  # noqa: BLE001
        log.warning("gen_runs persistence failed: %s", exc, ...)
        return None
```

Called from `scaffold_decorate`, `rgroup_enumerate`, `mmp_search`,
`bioisostere_replace`, `fragment_grow`, `fragment_link`. Each of these
async handlers blocks on connect → execute → execute (one INSERT per
proposal — up to 5000 in an enumeration). A blocking insert loop of 5000
INSERTs inside an async handler is the worst case.

Fix: switch to `psycopg-pool` async pool, perform the inserts in batch
(`executemany`) under `async with pool.connection()`. The exception swallow
(line 153) is itself a separable concern (MED-3 in this catalog).

### CRIT-8 — `mcp_logs_sciy` opens fresh DB connection per call

Severity: Critical
Service: `mcp_logs_sciy`
Files: `services/mcp_tools/mcp_logs_sciy/backends/fake_postgres.py:104–113, 210, 218`.

Evidence:

```python
# backends/fake_postgres.py:110–113
async def _connect(self) -> psycopg.AsyncConnection[dict[str, Any]]:
    return await psycopg.AsyncConnection.connect(
        self._dsn, autocommit=True, row_factory=dict_row
    )
```

Each call to `query_datasets`, `fetch_dataset`, etc. opens then closes a
fresh AsyncConnection (lines 210, 218 inside `query_datasets` open one
connection per request). At any meaningful RPS this is wasteful and fragile.

Fix: switch the backend to hold a `psycopg_pool.AsyncConnectionPool` opened
in lifespan, exactly the way `mcp_eln_local/main.py:105–127` does it.

### CRIT-9 — `mcp_chemprop` does not validate SMILES before model invocation

Severity: Critical
Service: `mcp_chemprop`
Files: `services/mcp_tools/mcp_chemprop/main.py:111–132, 156–171`.

The handler accepts the bounded-length string list (line 96–98) and pushes
straight into `cp_data.MoleculeDatapoint.from_smi(smi)`. An invalid SMILES
surfaces as a chemprop traceback (mapped by `create_app` to a 500), not a
`ValueError → 400` with a specific reason. The agent has no way to
distinguish "your input was wrong" from "the service is broken".

Fix: pre-validate every entry with the shared `mol_from_smiles` helper
(itself the proposed `common/chemistry.py` module from PR-7). The
overhead is ~1 ms per molecule in pure CPU; cheap.

### HIGH-1 — `/conformer_ensemble` numerical-output behavioural change

Severity: High
Service: `mcp_xtb`
Files: `services/mcp_tools/mcp_xtb/recipes/optimize_ensemble.py:11–14, 110–124`;
called from `services/mcp_tools/mcp_xtb/main.py:969–994`.

Evidence:

```python
# recipes/optimize_ensemble.py:11–14
"""Behaviour change vs the legacy ``/conformer_ensemble`` handler: weights
are now derived from optimised energies, not CREST's pre-opt energies,
and the partition function uses RT(298.15 K) ≈ 0.5925 kcal/mol rather
than the implicit RT = 1 kcal/mol the legacy code used.
"""
```

```python
# recipes/optimize_ensemble.py:110–124
async def _boltzmann(ctx: Ctx) -> list[dict[str, Any]]:
    ...
    exp_vals = [
        math.exp(-(e - e_min) * _HARTREE_TO_KCAL / _RT_298_KCAL)   # 627.509 / 0.5925
        for e in energies
    ]
```

Compare to the legacy implementation at `services/mcp_tools/mcp_crest/main.py:127–140`:

```python
# crest/main.py:130–135 (legacy)
exp_vals = [
    math.exp(-(e["energy_hartree"] - e_min) * 627.509)   # implicit RT = 1 kcal/mol
    if math.isfinite(e["energy_hartree"]) else 0.0
    for e in entries
]
```

The numerical contract changed. The route shape is identical, so the
agent-side builtin reads the new weights as if they were old ones. This
contradicts the implicit principle in the PR-7 audit ("preserve existing
behaviour"). The docstring is honest about the change, but no consumer
sees the docstring.

Fix: at minimum bump the route to `/v2/conformer_ensemble`, or expose a
`legacy_weights: bool = False` flag, or document the new weights in
`services/agent-claw/src/tools/builtins/conformer_ensemble.ts` so the
TypeScript layer can flag it as a divergence in the response narrative.

### HIGH-2 — `mcp_doc_fetcher` uses sync httpx in async handlers

Severity: High
Service: `mcp_doc_fetcher`
Files: `services/mcp_tools/mcp_doc_fetcher/fetchers.py:118`; consumers at
`services/mcp_tools/mcp_doc_fetcher/main.py:80, 104, 125`.

Evidence:

```python
# fetchers.py:118
with httpx.Client(follow_redirects=False, timeout=30) as client:
    ...
    with client.stream("GET", current_uri, headers=headers) as response:
```

The call site (`fetch_https`) is sync; `main.py:90` calls it inside `async
def fetch`. A 30-second blocking stream blocks the event loop. Compare to
`mcp_yield_baseline` which fixes the exact same pattern via
`anyio.to_thread.run_sync` at `mcp_yield_baseline/main.py:163, 280, 287`.

Fix: rewrite `fetchers.py` to use `httpx.AsyncClient`, OR wrap each call
in the route with `await anyio.to_thread.run_sync(...)` (matches the
yield-baseline pattern; preserves the "tests monkey-patch
`main.httpx.Client`" contract at `main.py:21`).

### HIGH-3 — `mcp_kg` has no real `/readyz`

Severity: High
Service: `mcp_kg`
Files: `services/mcp_tools/mcp_kg/main.py:78–88`.

Evidence:

```python
# main.py:78–82
# create_app() expects a sync ready_check returning bool. We expose the
# Neo4j check via the lifespan and let /readyz use the default ok response;
# a degraded response will surface naturally on the first failed write/query.
# The lifespan above logs "skipped" if Neo4j is unreachable at boot.
app = create_app(
    name="mcp-kg",
    version="0.1.0",
    log_level=settings.log_level,
    lifespan=_lifespan,
    required_scope="mcp_kg:rw",
)
```

The comment is wrong about k8s semantics — readiness isn't supposed to
flip on the *first* failed request; it's supposed to keep an unhealthy
pod out of the pool *before* the request lands. The fix is straight-
forward: the lifespan already calls `await drv.verify()` (line 51); cache
the result with a TTL on `_health_holder["ready"]` and pass a sync wrapper
into `create_app(ready_check=...)`. Cycle 5 of the auth path uses the
same idiom for the catalog-omission guard.

### HIGH-4 — `mcp_eln_local._ready_check` doesn't probe the pool

Severity: High
Service: `mcp_eln_local`
Files: `services/mcp_tools/mcp_eln_local/main.py:118–122, 130–132`.

Evidence:

```python
# main.py:117–122
if settings.mock_eln_enabled:
    try:
        await pool.open(wait=False)
        _pool_holder["pool"] = pool
    except Exception as exc:  # noqa: BLE001 — DB may not be up yet
        log.warning("mcp-eln-local: pool.open failed: %s", exc)
yield
```

```python
# main.py:130–132
def _ready_check() -> bool:
    """Sync ready check: feature-flag gates this; DB liveness is best-effort."""
    return bool(settings.mock_eln_enabled)
```

If `pool.open` fails, the warning goes to logs and `_ready_check` still
returns True. Every request returns 503 (line 147–150) but k8s thinks the
pod is healthy.

Fix: track pool open/closed state in `_pool_holder` (it already is —
just check `"pool" in _pool_holder`).

### HIGH-5 — `mcp_drfp` blocks the event loop

Severity: High
Service: `mcp_drfp`
Files: `services/mcp_tools/mcp_drfp/main.py:62–71`.

`DrfpEncoder.encode` is a CPU-bound numpy/RDKit operation, inside
`async def`. Per-call latency 50–500 ms on real reactions. Wrap in
`asyncio.to_thread`.

### HIGH-6 — `mcp_embedder` model download in async handler

Severity: High
Service: `mcp_embedder`
Files: `services/mcp_tools/mcp_embedder/main.py:54–70`; encoder load at
`services/mcp_tools/mcp_embedder/encoder.py:41–51, 53`.

Evidence:

```python
# encoder.py:41–51
def _ensure_loaded(self) -> None:
    if self._model is not None:
        return
    # Import inside to avoid heavy import at module load.
    from sentence_transformers import SentenceTransformer
    self._model = SentenceTransformer(self._model_name, device=self._device)
```

`embed_text` calls `self._encoder.encode(...)` (line 57), which calls
`_ensure_loaded()`. On a fresh container the BGE-M3 model is hundreds of
MB; downloading takes minutes; that download happens inline on the first
request, blocking the event loop for the entire download. All concurrent
requests stall.

Compounded by line 35 (`_encoder: Encoder = _build_encoder()`) — the
constructor is run at module import, so the *worker* doesn't start
serving traffic until that succeeds. A network blip at startup ⇒ the
worker never binds the port.

Fix: warm in lifespan:

```python
@asynccontextmanager
async def _lifespan(_app: FastAPI):
    global _encoder
    _encoder = _build_encoder()
    await asyncio.to_thread(_encoder.encode, ["warm-up"], normalize=True)
    yield
```

Then make `_ready` gate on the warm-up succeeding.

### HIGH-7 — `mcp_rdkit.bulk_substructure_search` blocks the event loop

Severity: High
Service: `mcp_rdkit`
Files: `services/mcp_tools/mcp_rdkit/main.py:288–311`.

Up to 5000 candidates × `Chem.MolFromSmiles` + `GetSubstructMatches` per
candidate, all inline inside the async handler. RDKit MolFromSmiles is
~1–5 ms on small molecules; 5000 of them is 5–25 seconds of pure event-loop
blocking.

Fix: wrap the entire `for cand in req.candidates[:req.limit]` loop in
`await asyncio.to_thread(...)`.

### HIGH-8 — `mcp_green_chemistry` re-parses SMARTS per request

Severity: High
Service: `mcp_green_chemistry`
Files: `services/mcp_tools/mcp_green_chemistry/main.py:291–312`.

Evidence:

```python
def _scan_bretherick(reactants_smiles: str) -> list[HazardousGroupHit]:
    hits: list[HazardousGroupHit] = []
    for s in reactants_smiles.split("."):
        mol = Chem.MolFromSmiles(s)
        if mol is None:
            continue
        for group in _BRETHERICK_GROUPS:
            patt = Chem.MolFromSmarts(group["smarts"])  # ← re-parsed every request, every reactant
            if patt is None:
                continue
            matches = mol.GetSubstructMatches(patt)
            ...
```

Bretherick patterns are static. Pre-compile in `_lifespan`:

```python
_BRETHERICK_GROUPS = _load_bretherick()
for g in _BRETHERICK_GROUPS:
    g["pattern"] = Chem.MolFromSmarts(g["smarts"])
```

### HIGH-9 — `mcp_ord_io` re-imports `ord_schema` per request

Severity: High
Service: `mcp_ord_io`
Files: `services/mcp_tools/mcp_ord_io/main.py:88–91, 139–142`.

Evidence: every `/export` and `/import` route does `from ord_schema.proto
import dataset_pb2, reaction_pb2` *inside* the route. ord_schema is in
`requirements.txt`; this is not a soft-dep guard. Move the import to module
top.

### HIGH-10 — `mcp_doc_fetcher` has no `ready_check`

Severity: High
Service: `mcp_doc_fetcher`
Files: `services/mcp_tools/mcp_doc_fetcher/main.py:57–62`.

The service has hard runtime deps on `httpx`, `pypdf`, `pdf2image` (the
last one is the most fragile — needs poppler system package). `/readyz`
should fail-closed if any of these can't be imported.

### HIGH-11 — `_constraints.txt` rotted

Severity: High
Service: all
Files: `services/_constraints.txt:1–25`; `services/mcp_tools/common/requirements.txt:1`,
`services/mcp_tools/mcp_tabicl/requirements.txt`.

Evidence: only those two requirement files contain `-c ../../_constraints.txt`.
The other 21 mcp_tools services declare `fastapi>=0.115` /
`pydantic>=2.8` etc. with no constraint-file pin. The header of
`_constraints.txt` says "Use from any service requirements.txt via `-c
../../_constraints.txt`" — clearly intended to be universal, but only
2/23 follow through. The original PR-7 fix W2.18 has bit-rotted.

Fix: prepend `-c ../../_constraints.txt` to every other
`services/mcp_tools/mcp_*/requirements.txt`. Alphabetical scan + 21
one-line edits.

### HIGH-12 — Four services have zero tests

Severity: High
Service: `mcp_drfp`, `mcp_embedder`, `mcp_kg`, `mcp_rdkit`
Files: n/a (the absence is the finding).

`mcp_doc_fetcher` and `mcp_tabicl` have repo-level tests at
`tests/unit/test_mcp_doc_fetcher.py` and `tests/unit/test_mcp_tabicl_*.py`,
which cover the absence of a per-service `tests/` directory. The four
listed above have no tests anywhere. Each is foundational — `mcp_rdkit` is
called by the agent's canonicalization on every reaction lookup.

### MED-1 — `MolFromSmiles → if mol is None: raise ValueError(...)` duplication

Severity: Medium
Service: cross-service
Files: 8 locations enumerated in the executive summary.

The PR-7 audit (`02-python-hotspots.md:135`) recommended landing
`services/mcp_tools/common/chemistry.py: mol_from_smiles(smiles, *,
max_len=MAX_SMILES_LEN)`. It still hasn't landed. Each duplicate uses a
slightly different error message (some echo the SMILES — leak risk
following the `mcp_synthegy_mech.canonical_smiles` precedent at
`mcp_synthegy_mech/main.py:218–224` of *not* echoing the value).

### MED-2 — `mcp_plate_designer` shadows the `create_app` ValueError handler

Severity: Medium
Service: `mcp_plate_designer`
Files: `services/mcp_tools/mcp_plate_designer/main.py:120–141`.

Evidence:

```python
except ValueError as exc:
    msg = str(exc)
    if msg.startswith("empty_categorical:"):
        raise HTTPException(status_code=422, detail=msg) from exc
    if msg.startswith("unknown plate_format"):
        raise HTTPException(status_code=422, detail=msg) from exc
    if "exceeds plate" in msg:
        raise HTTPException(status_code=422, detail=msg) from exc
    raise HTTPException(status_code=422, detail=f"infeasible_domain: {msg}") from exc
```

String-matching exception messages is fragile — a developer changing
`"empty_categorical:"` to `"empty-categorical:"` in `_designer` silently
falls through to the `infeasible_domain` branch.

Fix: define typed exceptions in `_designer` (`EmptyCategoricalError`,
`UnknownPlateFormatError`, `InfeasibleDomainError`); catch the type and
map to 422 without string comparison. The `create_app` `ValueError → 400`
handler is fine for any other ValueError that escapes.

### MED-3 — `mcp_genchem._record_run` swallows DB errors

Severity: Medium
Service: `mcp_genchem`
Files: `services/mcp_tools/mcp_genchem/main.py:118–155`.

The `except Exception as exc: log.warning(...)` at line 153 means a SQL
error (RLS denial, connection failure, schema drift) becomes a silent
warning. The route returns `run_id=None` and the caller proceeds.
Generated proposals appear valid but are not persisted — they vanish at
process exit.

Fix: at minimum make `persistence_status` part of the response so the
caller can react. Better: distinguish recoverable from unrecoverable
failures and re-raise the latter.

### MED-4 — `mcp_drfp` exception wrapping is too broad

Severity: Medium
Service: `mcp_drfp`
Files: `services/mcp_tools/mcp_drfp/main.py:62–74`.

`except Exception as exc: raise ValueError(f"DRFP encoding failed: {exc}")
from exc` masks the difference between (a) bad input SMILES, (b) DRFP
internal panic, (c) an OOM. All become `400 invalid_input` to the caller.

Fix: catch `ValueError`/`KeyError` for input issues and re-raise; let the
rest bubble (mapped to 500 by `create_app`).

### MED-5 — `mcp_aizynth` accepts unvalidated stocks list

Severity: Medium
Service: `mcp_aizynth`
Files: `services/mcp_tools/mcp_aizynth/main.py:77, 93–95`.

Pydantic only enforces length (`max_length=20`) on the list — each
stock name is unconstrained. `finder.stock.select(stock_name)` on an
unknown name raises a runtime error from aizynthfinder; if it accepts a
filesystem-path-shaped input (which some legacy stock loaders do), this
is a user-controlled disk read. The agent-side scope already gates the
API, but defence-in-depth is cheap.

### MED-6 — `mcp_logs_sciy` `/readyz` doesn't probe the backend

Severity: Medium
Service: `mcp_logs_sciy`
Files: `services/mcp_tools/mcp_logs_sciy/main.py:307–315`;
`services/mcp_tools/mcp_logs_sciy/backends/fake_postgres.py:115–124`.

The fake-postgres backend exposes `async def ready(self)` that does
`SELECT 1 FROM fake_logs.datasets LIMIT 1`. It is **never called** —
`_ready_check` returns `_health_holder["healthy"]` which is set
unconditionally to True at lifespan start (line 292:
`_health_holder["healthy"] = settings.backend == "fake-postgres"`).

### MED-7 — `mcp_reaction_optimizer.recommend_next` blocks on BoFire BO

Severity: Medium
Service: `mcp_reaction_optimizer`
Files: `services/mcp_tools/mcp_reaction_optimizer/main.py:173–203`.

BoFire BO converges in seconds to minutes for non-trivial campaigns. Wrap
in `to_thread`; same for `extract_pareto`.

### MED-8 — `mcp_reaction_optimizer` re-imports bofire per request

Severity: Medium
Service: `mcp_reaction_optimizer`
Files: `services/mcp_tools/mcp_reaction_optimizer/main.py:90–96, 142–143`.

bofire is a hard dep (`requirements.txt:5`). Move imports to module top.

### MED-9 — `mcp_tabicl` reloads PCA on every request

Severity: Medium
Service: `mcp_tabicl`
Files: `services/mcp_tools/mcp_tabicl/main.py:96–99, 103, 145`.

Evidence:

```python
def _require_pca() -> FittedPca:
    if not pca_path.exists():
        raise HTTPException(status_code=503, detail="PCA artifact missing")
    return load(pca_path)   # ← reloads from disk every call

@app.post("/featurize", response_model=FeaturizeOut)
def _featurize(payload: FeaturizeIn) -> FeaturizeOut:
    fitted = _require_pca()
    ...
```

Fix: cache `FittedPca` in lifespan; `/pca_refit` swaps it.

### MED-10 — `mcp_tabicl` parallel admin auth surface

Severity: Medium
Service: `mcp_tabicl`
Files: `services/mcp_tools/mcp_tabicl/main.py:160–174`.

The `MCP_TABICL_ADMIN_TOKEN` env-var + `x-admin-token` header pattern
parallels the JWT flow. The `compare_digest` use is correct, but having
two independent admin-auth surfaces violates the "single source of truth"
principle in the system prompt.

Fix: retire the env-var token; add a `mcp_tabicl:admin` scope and gate
`/pca_refit` on it. Or document the rationale prominently.

### MED-11 — `mcp_embedder` builds encoder at import

Severity: Medium
Service: `mcp_embedder`
Files: `services/mcp_tools/mcp_embedder/main.py:28–35`.

```python
def _build_encoder() -> Encoder:
    if settings.embed_model_name == "stub-encoder":
        log.warning("Using stub encoder (dev-only — not semantic)")
        return StubEncoder()
    return BGEM3Encoder(settings.embed_model_name, settings.embed_device)


_encoder: Encoder = _build_encoder()  # ← runs at import
```

Move into lifespan. Also see HIGH-6 for the cold-load problem.

### MED-12 — `mcp_drfp` no `ready_check`

Severity: Medium
Service: `mcp_drfp`
Files: `services/mcp_tools/mcp_drfp/main.py:27–32`.

Already covered in scorecard. `from drfp import DrfpEncoder` at module top
(line 17) means an import failure prevents startup, but a runtime DRFP
upgrade-incompatibility wouldn't be caught at /readyz.

### MED-13 — `mcp_rdkit` no `ready_check`

Severity: Medium
Service: `mcp_rdkit`
Files: `services/mcp_tools/mcp_rdkit/main.py:56–61`.

### MED-14 — `mcp_eln_local` swallows pool.open failure

Severity: Medium
Service: `mcp_eln_local`
Files: `services/mcp_tools/mcp_eln_local/main.py:118–122`.

See HIGH-4 for the consumer-side impact. The lifespan tolerates the
failure to keep the pod up, which is reasonable, but `_ready_check` then
needs to know.

### MED-15 — `mcp_doc_fetcher` re-raises generic Exception with leaky detail

Severity: Medium
Service: `mcp_doc_fetcher`
Files: `services/mcp_tools/mcp_doc_fetcher/main.py:91–95, 113–115, 140–142`.

```python
except Exception as exc:
    raise ValueError(f"fetch failed: {exc}") from exc
```

`exc` from httpx may include the URL the redirect chased to (which
sometimes carries session tokens for SharePoint-like fetches). Compare to
`mcp_yield_baseline/main.py:167, 284, 291` which redact:

```python
except httpx.HTTPError as exc:
    log.warning("drfp upstream call failed", extra={"err": type(exc).__name__})
    raise HTTPException(status_code=503, detail="drfp_unavailable") from exc
```

Fix: log full `exc` server-side; return generic `"fetch failed"` (no
interpolation).

### MED-16 — `mcp_yield_baseline` global model load can crash worker

Severity: Medium
Service: `mcp_yield_baseline`
Files: `services/mcp_tools/mcp_yield_baseline/main.py:40–62`.

```python
def _load_global_xgb() -> Any | None:
    if not _GLOBAL_XGB_PATH.exists():
        return None
    try:
        import xgboost as xgb  # noqa: PLC0415
    except ImportError:
        log.warning("xgboost not installed; global model unavailable")
        return None
    booster = xgb.Booster()
    booster.load_model(str(_GLOBAL_XGB_PATH))   # ← unguarded
    return booster
```

If the artifact exists but is corrupt or a wrong-version on-disk format,
`load_model` raises and the lifespan crashes the whole app. Wrap with
try/except, log, and set `_GLOBAL_XGB_MODEL = None`.

### LOW-1 — Dev-sentinel password guard duplicated

Severity: Low
Service: `mcp_eln_local` + `mcp_logs_sciy`
Files: `services/mcp_tools/mcp_eln_local/main.py:90–102`,
`services/mcp_tools/mcp_logs_sciy/main.py:259–272`.

Lift to `services/mcp_tools/common/dsn_safety.py:
assert_no_dev_sentinel_in_dsn(dsn, sentinel, opt_out_env_var)`. Two-line
helper.

### LOW-2 — DB pool lifespan triplet duplicated

Severity: Low
Service: `mcp_eln_local`, `mcp_logs_sciy` (different shapes), `mcp_kg`
Files: `mcp_eln_local/main.py:87–127`, `mcp_logs_sciy/main.py:247–297`,
`mcp_kg/main.py:35–69`.

Three different shapes for "open pool / driver in lifespan, hold in
module-level dict, expose `acquire` for routes". Lift to
`common/db_pool.py: make_pool_lifespan(name, dsn, **kwargs)`.

### LOW-3 — `mcp_rdkit` substructure-match limit

Severity: Low
Service: `mcp_rdkit`
Files: `services/mcp_tools/mcp_rdkit/main.py:242–252, 288–311`.

`target.GetSubstructMatches(query, useChirality=req.use_chirality,
uniquify=True)` has no upper bound on returned matches. RDKit ≥ 2023.09
takes a `maxMatches` parameter; cap at e.g. 1000 to avoid pathological
queries returning megabytes of match arrays.

### LOW-4 — Calibration cache scope

Severity: Low
Service: `mcp_applicability_domain`
Files: `services/mcp_tools/mcp_applicability_domain/main.py:75–96`.

Module-level dict; under multi-worker uvicorn (which the service does not
do today), each worker has its own. Document or shard via Redis if scale
demands it.

### LOW-5 — `_acquire` HTTPException leaks DSN fragments

Severity: Low
Service: `mcp_eln_local`
Files: `services/mcp_tools/mcp_eln_local/main.py:155–159`.

```python
except (psycopg.OperationalError, psycopg_pool.PoolTimeout, psycopg_pool.PoolClosed) as exc:
    raise HTTPException(
        status_code=503,
        detail={"error": "service_unavailable", "detail": f"mock_eln DB unavailable: {exc}"},
    ) from exc
```

`OperationalError`'s `str` may contain DSN fragments depending on the
psycopg version and the connection failure mode (e.g. `connection failed:
connection to server at "<host>", user "<user>", database "<db>" failed`).

Log full `exc` server-side; return `"mock_eln DB unavailable"` (no
interpolation) to clients.

## Cross-Reference: Prior Audit

The 2026-04-29 audit (`docs/review/2026-04-29-codebase-audit/02-python-hotspots.md`)
flagged three god-files. Two have been split (eln_local, doc_fetcher, both
visible at the current repo state); the third (`mock_eln/seed/generator.py`)
is outside the MCP fleet so isn't in the scope of this audit. Findings
this audit reaffirms or extends:

1. **PR-7 W2.18 (`_constraints.txt` adoption)** — partially landed (2 of
   23 services). HIGH-11 here.
2. **PR-7 shared `mol_from_smiles` helper** — not landed. MED-1 here.
   The duplicate count grew from 6 (in the prior audit) to 8 because
   `mcp_synthegy_mech` and `mcp_crest` (both newer than the audit) also
   re-implement the pattern.
3. **PR-7 doc_fetcher split** — landed. The new `fetchers.py` is clean,
   but the sync-httpx-in-async pattern (HIGH-2 here) was preserved across
   the split and is independently a problem.
4. **PR-7 eln_local split** — landed. `routes.py` / `models.py` /
   `queries.py` are all in place. The `pool.open` swallow + ready_check
   discrepancy noted in HIGH-4 of this audit was pre-existing in the
   pre-split file (line 117–122 of the legacy 969-LOC main.py at audit
   time) and survived the refactor.
5. **`_acquire` lifespan triplet (PR-7 audit "Duplication" #1)** —
   `mcp_logs_sciy` did not migrate to it; in fact it went the other way
   and opens a fresh AsyncConnection per call (CRIT-8 here). LOW-2 here.

The `mcp_xtb` workflow engine (commit `c72dd92`) post-dates the prior
audit; the audit's mcp_xtb section was a 289-LOC main.py skim. The
1045-LOC main.py today carries 14 single-shot endpoints with the
async/blocking pattern that wasn't in scope last time (CRIT-1).
