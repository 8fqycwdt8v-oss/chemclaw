# Test Integrity Audit — 2026-05-03

**Auditor scope:** read-only. Goal: assess whether the test suite tells
the truth about the production system, or whether mocks have papered
over runtime defects (the signal Wave 1 surfaced in `kg_source_cache`
and `services/workflow_engine`).

**HEAD:** `41d653d` (main).

---

## Executive Summary (≤ 800 words)

The repo's *headline* test posture is strong — 1072 agent-claw tests pass,
23 paperclip tests pass, 327 MCP-tool tests pass, 57 projector tests pass,
6 optimizer tests pass — but the *truth-value* of those numbers is
substantially lower than they suggest. **Three distinct kinds of
test-integrity failure** are present in this build, each of which already
has a concrete Wave 1 instance proving it is load-bearing:

1. **Stub-mocked DB writes that never see Postgres validation.** The
   `kg_source_cache` projector test (`services/projectors/kg_source_cache/tests/test_kg_source_cache.py`)
   stubs the Neo4j driver and never inserts into `ingestion_events` — so
   the UUID-cast bug in `services/agent-claw/src/core/hooks/source-cache.ts:370-378`
   that the W1.7 audit caught (a non-UUID string in a `UUID` column)
   passes CI green every time. The same hook's TS unit test
   (`services/agent-claw/tests/unit/hooks-source-cache.test.ts:30-36`)
   mocks `withUserContext` so the column type is never exercised. Both
   testing layers conspire to hide one runtime-fatal defect.
2. **Coverage-by-helper rather than coverage-by-behaviour.** The
   Postgres-backed workflow engine has 4 tests
   (`services/workflow_engine/tests/test_engine.py`) — all four exercise
   pure helpers (`_resolve_jmespath`, `_tool_url`). Zero tests cover
   `_advance_run`, `_sweep`, `_exec_tool_call`, `_exec_wait`, `_finish`,
   step-failed paths, the silent no-op for unimplemented step kinds, or
   the `psycopg`/`asyncpg` placeholder issue Wave 1 caught (W1.8). The
   queue worker is worse — its test files cover handler-table membership
   and JWT minting only; **`_lease_one`, `_sweep_all`, `_maybe_retry`,
   and `_fail` have zero tests**.
3. **Failing tests in `tests/unit/` are not run by CI.** Eight tests
   in `tests/unit/test_mcp_doc_fetcher.py`, three in
   `tests/unit/test_mcp_tabicl_api.py`, and one in
   `tests/unit/test_mcp_tabicl_featurizer.py` fail on a fresh
   pytest invocation (renamed function `_ip_is_blocked → ip_is_blocked`
   moved from `main.py` to `validators.py`; tabicl tests rely on
   conftest from `services/mcp_tools/conftest.py` that `tests/unit` does
   not inherit). The CI workflow at `.github/workflows/ci.yml:92-102`
   only runs an explicit allowlist (`tests/unit/test_redactor.py`,
   `tests/unit/optimizer/test_session_purger.py`, plus per-service
   directories). Every other file under `tests/unit/` is "tracked" but
   not executed; broken tests rot silently.

The **integration trio** (etag-conflict, chained-execution,
reanimator-roundtrip) is well-engineered (`describe.skipIf(!dockerAvailable)`,
testcontainer harness in `tests/helpers/postgres-container.ts`) and DOES
run in this audit's full suite (the etag-conflict test ran for 8.83s
against a real testcontainer). However the GitHub Actions CI workflow
does NOT install Docker for the TypeScript job — it runs `npm test`
which on the GitHub runner has Docker available implicitly, but the
workflow file makes no explicit `services:` declaration, leaving the
real-Postgres path silently dependent on the runner image. CI will go
silently green if the testcontainer fails to start.

The **golden set** (`tests/golden/chem_qa_v1.fixture.jsonl` +
`chem_qa_holdout_v1.fixture.jsonl`) totals **15 entries** (10 + 5).
Every entry has `"expected_fact_ids": []` — empty. The notes field
labels each as "Fixture example — …" These are placeholder-quality
golden entries, not authentic scientific scenarios with traceable KG
fact IDs. The promotion gate that CLAUDE.md describes ("DSPy GEPA
nightly optimizer; golden set + held-out promotion gate") cannot be
operating on real fact-grounded behaviour.

The **mock vs real boundary** for source-system MCPs is healthy in one
direction (the `real` backend has a single test asserting
`NotImplementedError` is raised — `test_real_backend_raises_not_implemented`
in `services/mcp_tools/mcp_logs_sciy/tests/test_mcp_logs_sciy.py:285-291`),
but the `fake_logs` and `mock_eln` fixtures themselves are excellent
quality (3000+ datasets, 4228 ELN entries, 150 reactions, real chemistry
families) — that part is solid.

**Skipped tests are well-justified** — every `@pytest.mark.skipif` is
gated on `NEO4J_URI` / `POSTGRES_HOST` / `NEO4J_INTEGRATION`, and every
TS skip is gated on `isDockerAvailable()`. There are zero
technical-debt skips (no `it.todo`, no commented-out failing tests).
This is the one structural strength of the suite.

**The single most important fix** is to add at least one real-Postgres
integration test for the source-cache hook → `kg_source_cache` projector
loop. That single test would have caught the W1.7 UUID-cast defect.
Without it the next analogous schema-vs-runtime mismatch will slip
through identically.

---

## Test-Run Status

| Suite | Command | Status | Tests | Notes |
|---|---|---|---:|---|
| agent-claw | `npm test --workspace services/agent-claw` | PASS | 1072/1072 | 146 files; integration trio runs (etag-conflict 8.83s) |
| paperclip | `npm test --workspace services/paperclip` | PASS | 23/23 | 2 files |
| mcp_tools (excl yield_baseline) | `pytest services/mcp_tools/ --ignore=mcp_yield_baseline` | PASS | 306 | conftest sets `MCP_AUTH_DEV_MODE=true` |
| mcp_yield_baseline | `pytest services/mcp_tools/mcp_yield_baseline/tests/` | PASS | 21 | Run separately because xgboost segfaults when imported alongside RDKit's torch — **fragile** |
| mcp_tools combined | `pytest services/mcp_tools/` | **CRASH** | n/a | `Fatal Python error: Segmentation fault` from xgboost + torch interaction at line 3050 of `xgboost/core.py`. The `make test` target hits this. |
| projectors | `pytest services/projectors/` | PASS | 57/57 | All mocked; no real Postgres exercised |
| optimizer | `pytest services/optimizer/` | PASS | 6/6 | Tiny coverage; relies on `dspy` for the rest |
| tests/unit (excl optimizer/dspy + 3 broken files) | see below | PASS | 147 | |
| tests/unit (full) | `pytest tests/unit -q` | **FAIL** | 11 failures + 3 collect errors | See below |
| services/queue + workflow_engine | `pytest services/queue/ services/workflow_engine/` | PASS | 13/13 | helper-only |

### tests/unit failures (read-only inspection)

```
tests/unit/test_mcp_doc_fetcher.py: 8 ImportError —
  cannot import name '_ip_is_blocked' from 'services.mcp_tools.mcp_doc_fetcher.main'
  (the function moved to validators.py and was renamed `ip_is_blocked` —
   the tests were not updated)
tests/unit/test_mcp_tabicl_api.py: 3 failures —
  401 Unauthorized (the per-service conftest at
  services/mcp_tools/conftest.py sets MCP_AUTH_DEV_MODE=true at
  collection time, but tests under tests/unit/ do not inherit that
  conftest path)
tests/unit/test_mcp_tabicl_featurizer.py: 1 failure —
  X.shape == (0, 38) != (1, 38) — the featurizer skipped the row;
  silent regression, not test infrastructure
tests/unit/optimizer/test_gepa_*.py: 3 collect errors — `import dspy`
  fails because dspy is not installed in the local .venv (fine — these
  are intentionally optimizer-tier dependencies)
```

CI never sees these failures because `.github/workflows/ci.yml:92-102`
runs only a subset of tests/unit (`test_redactor.py`,
`test_session_purger.py`) and the per-service `services/.../tests/`
trees, not `tests/unit/` as a whole.

### `make test` blast radius

```bash
$ .venv/bin/pytest services/mcp_tools/ -q
... 26 tests into yield_baseline ...
Fatal Python error: Segmentation fault
```

**`make test` is broken on this machine** as a one-shot run. CI
sidesteps the segfault by installing only the touched-service deps
(see `.github/workflows/ci.yml:80-89`), so xgboost is never imported
alongside torch. A developer running `make test` locally hits the
crash and concludes "tests are broken" — they aren't, but the test
runner is.

---

## Skipped-Test Inventory

| Test | File:line | Skip reason | Justified? |
|---|---|---|---|
| `test_kg_hypotheses_projector` (whole module) | `tests/integration/test_kg_hypotheses_projector.py:14-19` | requires `NEO4J_URI` env var | **Yes** — needs live Neo4j |
| `mcp_kg/test_bitemporal` (whole module) | `tests/integration/mcp_kg/test_bitemporal.py:29-32` | requires `NEO4J_INTEGRATION=1` | **Yes** — needs live Neo4j with stack up |
| `test_db_audit_fixes` (whole module) | `tests/integration/test_db_audit_fixes.py:24-27` | requires `POSTGRES_HOST` env | **Yes** — needs live Postgres |
| `test_db_audit_fixes::test_*_security_definer_function` | `:135` | function not present in this DB | **Yes** — graceful degrade for partial init |
| `test_hypotheses_schema` (whole module) | `tests/integration/test_hypotheses_schema.py:27` | requires `POSTGRES_HOST` | **Yes** — schema integration test |
| `etag-conflict.test.ts` (whole describe) | `services/agent-claw/tests/integration/etag-conflict.test.ts:39` | `!dockerAvailable` | **Yes** — testcontainer dep |
| `chained-execution.test.ts` (whole describe) | `services/agent-claw/tests/integration/chained-execution.test.ts:88` | `!dockerAvailable` | **Yes** |
| `reanimator-roundtrip.test.ts` (whole describe) | `services/agent-claw/tests/integration/reanimator-roundtrip.test.ts:114` | `!dockerAvailable` | **Yes** |

**Zero technical-debt skips found.** No `it.todo`, no `xit`, no
commented-out failing tests, no `pytest.mark.skip` without an `if` clause.
This is one of the suite's structural strengths.

---

## Mock-vs-Real Matrix per Subsystem

Classification:
- **Pure unit** = no I/O; mocks only on entrypoints. Good for logic.
- **Integration** = real Postgres / real HTTP / real fs.
- **Stub-mock** = claims to test integration but mocks every fragile boundary.

| Subsystem | Class | Slips Wave-1 bugs through? | Evidence |
|---|---|---|---|
| agent-claw routes (`/api/chat`, `/api/sessions`, `/api/plan`, `/api/deep_research`, `/api/admin/*`) | **Stub-mock** | YES | `tests/unit/chat-route.test.ts:23-40` uses `mockPool()` from `tests/helpers/mock-pg.ts`; the helper builds a `Pool` whose `query()` shifts canned `queryResults` off a stack. SQL strings are inspected by spy, not executed. A schema-drift bug (e.g. column-rename) cannot be detected. |
| agent-claw `source-cache` hook | **Stub-mock** | YES — Wave 1 W1.7 confirmed | `tests/unit/hooks-source-cache.test.ts:30-36` mocks `withUserContext` so the actual `INSERT INTO ingestion_events` SQL never executes against Postgres. The UUID-cast defect at `src/core/hooks/source-cache.ts:370-378` is invisible. **No integration test exists** for the hook → projector loop. |
| agent-claw tools (builtins) | **Stub-mock** | YES | `tests/unit/builtins/*.test.ts` — every test that calls an MCP-backed tool mocks `postJson`. The contract between `agent-claw` typed input and the FastAPI Pydantic schema is not exercised end-to-end by any test. |
| agent-claw harness control loop | **Mostly pure unit + 3 testcontainer integration tests** | Mostly NO | The `etag-conflict` / `chained-execution` / `reanimator-roundtrip` trio uses real Postgres via testcontainers; covers session-store + chained loop. The non-streaming chat path is unit-only. |
| workflow engine (Postgres-backed) | **Helper-only** | YES — Wave 1 W1.8 confirmed | `services/workflow_engine/tests/test_engine.py` covers `_resolve_jmespath` (2 cases) and `_tool_url` (2 cases). Zero tests for `_advance_run`, `_sweep`, `_exec_tool_call` (the path with the psycopg/asyncpg placeholder bug), `_exec_wait`, `_finish`, or the step-failed branch. **The bug Wave 1 found has no test scaffolding to catch it.** |
| queue worker | **No coverage of correctness invariants** | YES | `services/queue/tests/test_handlers.py` checks the handler-name registry (7 lines). `test_token_wiring.py` validates JWT minting per audience. **Zero tests** for `_lease_one` (CTE shape, SKIP LOCKED semantics, lease-priority ordering), `_sweep_all` (lease-reclaim UPDATE), `_maybe_retry` (transition matrix on attempts), `_fail` (final-attempt → failed status). |
| projectors (canonical) | **Stub-mock** | YES | `services/projectors/kg_source_cache/tests/test_kg_source_cache.py` mocks the KG client; `qm_kg/tests/test_qm_kg_projector.py` mocks the Neo4j driver. **Zero tests** for the LISTEN/NOTIFY loop, no real-Postgres integration. The `qm_kg` listen-loop crash on transient Neo4j errors (W7.F.4) cannot be caught. |
| MCP services (Pydantic + ValueError→400) | **Pure unit (FastAPI TestClient)** | NO for happy paths; YES for auth | Most services use `fastapi.testclient.TestClient` against the real app object — that's good. JWT middleware bypassed via `MCP_AUTH_DEV_MODE=true` from `services/mcp_tools/conftest.py`. **No test in any service verifies the JWT happy path** (all sign-and-verify tests live in `services/queue/tests/test_token_wiring.py` and the agent-side TS suite). |
| `kg_source_cache` writer-to-projector loop | **No tests at all** | YES | Neither the agent-side TS test nor the projector Python test exercises the full loop. The W1.7 defect would be caught by a single integration test that actually inserts the row. |
| Source-system MCPs (`mcp_eln_local`, `mcp_logs_sciy`) | **Stub-mock for backend** | YES | The Postgres backends are stubbed out via in-memory dict / row-replay queue (`tests/test_mcp_eln_local.py:25-60`). Schema drift on `mock_eln.entries` would not surface. The `real` LOGS backend has 1 test (`test_real_backend_raises_not_implemented`) — confirming it correctly raises NotImplementedError. |
| Skill-loader / skill-execution | **Pure unit** | Probably OK | Coverage of skill discovery, activation, and YAML parsing is good (`tests/unit/skills.test.ts`). |
| Litellm redactor + redaction patterns | **Pure unit; comprehensive** | NO | `tests/unit/test_redactor.py` exercises every category; CI runs it explicitly. |
| Configuration registry / feature flags / permission policies | **Pure unit** | NO | Thoroughly tested with mocked pool. |

**Bottom line:** every Wave-1 defect that landed in production code had
a "passing" unit test. The suite is **structurally arranged to give
false confidence** for any class of bug that requires the canonical
SQL pipeline to actually execute.

---

## Coverage Gaps (newly merged code)

Per the request, here are specific test cases that DO NOT exist but
SHOULD exist for each recently merged subsystem.

### Z0 condition-design (no dedicated MCP service for Z0; lives in agent-side builtins?)

**Location not found** — there is no `mcp_condition_design`
service. The `recommend_conditions` MCP tool (in `mcp_askcos`) appears
to cover this surface. Test gaps in `tests/unit/builtins/recommend_conditions.test.ts`
(7 tests, all mocked):
- No test for the case where AskCOS returns an empty `recommendations` array
- No test for the malformed-condition-string defensive parsing path
- No test for the agent-side prompt-injection guard (the freetext input
  is concatenated with system context — same risk surface as
  `mcp_synthegy_mech`'s prompt-tag stripping that IS tested)

### Z1 applicability-domain + green-chemistry

`services/mcp_tools/mcp_applicability_domain/tests/` (17 tests) +
`services/mcp_tools/mcp_green_chemistry/tests/` (14 tests).

Missing:
- **mcp_applicability_domain**: no test for the `_CALIBRATION_CACHE` TTL
  (cache hit path). Multi-worker uvicorn scenario (W6.LOW-4) untested.
- **mcp_green_chemistry**: no test for the per-request SMARTS reparse
  performance regression that would land if the lifespan precompile
  optimisation is reverted. No test for hazardous-group hits across
  multi-component reactants. No test for the bretherick file *missing*
  on disk (lifespan should still start).
- Neither service has a test that verifies `/readyz` actually fails
  when the artifact is missing in a way Kubernetes would notice.

### Z2 conditions normalizer (projector)

`services/projectors/conditions_normalizer/tests/` — five test files
(~40 tests). The strongest projector coverage in the repo.

Still missing:
- LISTEN/NOTIFY loop integration test: the projector starves today
  because `experiment_imported` has no live emitter (W7.F.2). No test
  catches the absence-of-events condition; the projector silently sits
  idle.
- LLM extractor tests mock `litellm.acompletion` — no test for the
  prompt-injection path (input contains XML that mimics system tags).

### Z3 yield-baseline

`services/mcp_tools/mcp_yield_baseline/tests/` (4 files, ~21 tests).

Missing:
- The xgboost+torch segfault scenario (`make test` cross-import) is
  not covered by any test.
- `_load_global_xgb` failure path (W6.MED-16): if the artifact exists
  but is corrupt, the lifespan crashes. No test simulates this.

### Z4 plate-designer + ord-io

`services/mcp_tools/mcp_plate_designer/tests/test_designer.py` (17 tests)
+ `mcp_ord_io/tests/test_ord_io.py` (5 tests).

Missing:
- **plate_designer**: no test for the string-matched ValueError-to-422
  mapping (W6.MED-2). A typo in the inner error message changes the
  HTTP status code with zero test signal.
- **ord_io**: no test for the per-request `ord_schema.proto` re-import
  performance regression (W6.HIGH-9). No test for malformed protobuf
  input (which would surface as a 5xx).

### Z5 reaction-optimizer

`services/mcp_tools/mcp_reaction_optimizer/tests/` (15 tests).

Missing:
- No test for the BoFire BO blocking-the-event-loop pattern
  (W6.MED-7). A sync test cannot detect this; needs an integration
  test that fires multiple concurrent `recommend_next` requests and
  measures fairness/parallelism.
- No test for empty-domain edge cases (every parameter constrained
  to a single value).

### Z6 multi-objective Pareto

Tested via `mcp_reaction_optimizer/tests/test_pareto.py` (8 tests).

Missing:
- No test with degenerate (all-equal) objectives — should the front
  collapse to one point or all points?
- No test for >2 objectives (the Pareto code likely handles n-D but
  isn't exercised).

### Z7 chemistry eval suite

The "eval suite" is `tests/golden/chem_qa_v1.fixture.jsonl` +
`chem_qa_holdout_v1.fixture.jsonl`. **15 entries total, every one
with `expected_fact_ids: []`**. There is no harness in this repo that
asserts a model's answer against the entries — only the structure of
the fixtures. See "Golden-Set Integrity" below.

### Z8 late-stage-functionalization + condition-design-from-literature

**No dedicated MCP services exist for these in `services/mcp_tools/`**
(grep finds no `mcp_lsf`, no `mcp_late_stage`, no
`mcp_condition_design_lit`). Either the names are different, or the
features are spread across existing services without a clear test
locus. **Test gap inventory cannot be built without first locating the
implementation.**

### Workflow engine (Phase 8)

See "Mock-vs-Real Matrix" — only 4 helper tests exist. Missing tests:
- `_advance_run` happy path + "no more steps" → finish
- `_sweep` with multiple `running` rows + concurrency race (multi-replica)
- `_exec_tool_call` with HTTP failure / timeout / 400-from-MCP
- `_exec_wait` with a batch that never completes (timeout path)
- The silent no-op for unimplemented step kinds (`conditional`, `loop`,
  `parallel`, `sub_agent` — W8.HIGH-1)
- `_append_event` seq uniqueness under simulated race
- `_finish` emits `ingestion_events` row (W8.MED-3 — currently it doesn't)
- The psycopg-vs-asyncpg placeholder bug surface (Wave 1 W1.8) needs an
  integration test against real Postgres

### Queue (Phase 6)

Two test files, 7 + 4 = 11 tests. Both files cover registry shape and
JWT signing. Missing:
- `_lease_one` CTE shape — what columns does it claim? Priority order
  correctness?
- `_lease_one` SKIP LOCKED behaviour — does a second worker correctly
  skip a leased row? Needs real Postgres.
- `_sweep_all` lease-reclaim UPDATE — expired leases reset to `pending`?
- `_maybe_retry` transition matrix: attempts < max → reset; attempts
  == max → `failed` with error JSONB
- `idempotency_key` deduplication — does inserting a duplicate row
  return the existing run? (Schema is `BYTEA`; tests don't verify this
  contract — W8.LOW-3)
- `retry_after` backoff logic — does NOT EXIST today (W8.MED-2); test
  would fail.
- Concurrency-semaphore bound under simulated burst.

### Source-system MCPs (eln_local, logs_sciy — Phase F.2)

`mcp_eln_local`: 22 test functions. Mock the entire DB pool via stub
cursor + canned reply queue. Missing:
- Any test that the SQL emitted matches the seeded schema in
  `services/mock_eln/seed/generator.py`. A column rename in either
  side breaks production silently.
- The OFAT-aware `query_eln_canonical_reactions` collapse logic — is
  the 200-row → 1-row reduction tested?
- The pool-open-failure swallow (W6.HIGH-4) — `_ready_check` returns
  True even when the pool is None.

`mcp_logs_sciy`: 15 test functions. Same pattern. Missing:
- Real-backend stub raises NotImplementedError — present (good).
- `_ready_check` doesn't probe the backend (W6.MED-6) — no test exercises
  this gap.
- No test that `fake_logs.datasets` schema in the `test-fixtures/fake_logs/`
  CSVs matches the expected query shape.

### Phase 9 workflow→tool promotion

`services/agent-claw/tests/unit/builtins/promote_workflow_to_tool.test.ts`
— 4 tests. Missing:
- No test that the inserted skill row sets `active = FALSE` (per
  W8.LOW-1). The current behaviour is a footgun: a promoted workflow
  is invisible to the harness without manual SQL.
- No test for the admin-gating semantics (does a `project_admin` work,
  or only `global_admin`?).
- No test for the round-trip "create workflow → promote → invoke as
  tool".

---

## Integration-Trio Status

CLAUDE.md states the trio runs and is gated by Docker.

**Verified wired:**
- `services/agent-claw/tests/integration/etag-conflict.test.ts:39` —
  `describe.skipIf(!dockerAvailable)`. Ran for 8.83s in this audit's
  full suite using a real testcontainer.
- `services/agent-claw/tests/integration/chained-execution.test.ts:88`
  — same pattern.
- `services/agent-claw/tests/integration/reanimator-roundtrip.test.ts:114`
  — same pattern.

The testcontainer harness is at
`services/agent-claw/tests/helpers/postgres-container.ts`.

**CI status:** The `.github/workflows/ci.yml` `typescript` job runs
`npm run coverage --workspace services/agent-claw` (line 40), which
includes integration files via the default vitest glob. Docker is
implicitly available on the GitHub-hosted ubuntu-latest runner.
**There is no explicit `services:` declaration for Postgres or Docker**
in the typescript job — if GitHub ever switches the runner image to
not include Docker, the trio silently skips and CI stays green. **This
is a CI-integrity tripwire** that should be made explicit.

The integration tests do NOT cover:
- the `kg_source_cache` writer-to-projector loop (the W1.7 hot path)
- the workflow engine's `_advance_run` against real Postgres (W1.8)
- the queue worker's `_lease_one` CTE
- the cross-language MCP boundary (no testcontainer test starts a
  Python service and an agent-claw against it)

---

## Golden-Set Integrity

Files inspected:
- `tests/golden/chem_qa_v1.fixture.jsonl` — 10 lines
- `tests/golden/chem_qa_holdout_v1.fixture.jsonl` — 5 lines

**Total: 15 entries.**

### Spot-check of 5 entries (chem_qa_v1):

| # | Question | `expected_fact_ids` | `expected_classes` | Notes field |
|---|---|---|---|---|
| 1 | "What retrosynthetic routes are available for synthesizing ibuprofen…" | `[]` | `["retrosynthesis"]` | `Fixture example — retrosynthesis class` |
| 2 | "What HPLC method conditions are typically used…" | `[]` | `["analytical"]` | `Fixture example — analytical class, HPLC method` |
| 4 | "How do yield outcomes for Buchwald-Hartwig amination compare across different projects…" | `[]` | `["cross_project"]` | `Fixture example — cross-project class` |
| 6 | "How should NMR data be interpreted for structural confirmation of a novel compound with multiple stereocenters?" | `[]` | `["analytical"]` | `Fixture example — analytical NMR` |
| 9 | "What retrosynthetic analysis would you apply to a macrolide antibiotic with a 14-membered lactone ring?" | `[]` | `["retrosynthesis"]` | `Fixture example — complex retrosynthesis` |

**Findings:**

1. **Every entry has `"expected_fact_ids": []`.** The promotion gate
   in CLAUDE.md ("DSPy GEPA nightly optimizer; golden set + held-out
   promotion gate") cannot ground correctness on KG fact IDs because
   no entry references any fact.
2. **Every `notes` field begins with `Fixture example — …` or `Holdout
   example — …`.** This labels them as *placeholder examples*, not as
   curated scientific scenarios drawn from real ChemClaw deployments.
3. **The questions and answers are scientifically reasonable** — the
   ibuprofen retrosynthesis answer correctly references the BHC green
   synthesis; the macrolide answer correctly cites Yamaguchi /
   Corey-Nicolaou. As text, these are not bad.
4. **But there is no harness in the repo that runs the golden set.**
   `grep -rn "chem_qa_v1\|chem_qa_holdout" services/ tests/` finds
   only `services/optimizer/scripts/seed_golden_set.py`. Whatever
   evaluator consumes these has not been wired into CI.
5. **15 entries total is small** for any meaningful evaluation — the
   training/holdout split is 10/5 which is essentially "two examples
   per class". Statistical power is zero.

The golden set is **shaped correctly** but **substantively
placeholder**. Treating its presence as evidence of an active eval
gate is wrong.

---

## Flaky-Test Inventory

Tests that look flaky-by-design (wall-clock asserts, sleep loops,
unseeded randomness):

| Test | File:line | Flake risk | Mitigation |
|---|---|---|---|
| `lifecycle-decisions.test.ts` (a never-resolving post_tool hook propagates timeout) | `services/agent-claw/tests/unit/lifecycle-decisions.test.ts:215-237` | Wall-clock asserts: `expect(elapsed).toBeLessThan(400); expect(elapsed).toBeGreaterThanOrEqual(80)` for a 100ms timeout. Slow CI may exceed 400ms. | Already widened to 400 (comment: "generous headroom on a slow CI runner"). Acceptable. |
| `lifecycle-decisions.test.ts` (pre_tool timeout) | `:251-260` | Same shape | Same mitigation |
| `hooks-redact-secrets.test.ts` (200KB redact under 1500ms) | `services/agent-claw/tests/unit/hooks-redact-secrets.test.ts:161-164` | 1500ms ceiling is generous but a slow shared CI runner could exceed it under load | Comment acknowledges contention; ceiling is wide |
| `hooks-redact-secrets.test.ts` (1MB arrow-free under 1500ms) | `:184-188` | Same | Same |
| `parallel-batch.test.ts` (delayed ms in batch) | `services/agent-claw/tests/unit/parallel-batch.test.ts:69-77` | Uses `setTimeout` + `Date.now()` to verify parallelism — sensitive to event-loop contention | Acceptable — parallelism is the concept under test |
| `config-registry.test.ts` (cache TTL) | `:126` | `setTimeout(r, 5)` for TTL — 5ms is tight | Likely OK but could flake on slow CI |

**No retry-loop-without-seeded-randomness, no network-without-retry,
no real-time test patterns observed.** The flake risk is contained
within ~6 wall-clock-bounded tests, all of which use generous ceilings.
This is healthier than typical.

---

## Test Data Quality

### `test-fixtures/mock_eln/world-default/` (gzipped CSV-COPY format)

| File | Rows | Notes |
|---|---:|---|
| `projects.copy.gz` | 4 | NCE-1234, NCE-5678, GEN-9999, FOR-1111 — 4 projects, matches CLAUDE.md spec |
| `entries.copy.gz` | 4228 | Real ELN-shaped rows with chemists, procedures, conditions, OFAT campaign IDs |
| `reactions.copy.gz` | 150 | Realistic SMARTS/SMILES (`CCCO>>CCC=O`, `O=Cc1ccc(F)cc1.CCN>>O=Cc1ccc(F)cc1`) with reaction families (oxidation, amide_coupling, reductive_amination) |
| `compounds.copy.gz` | (inspected — present) | |
| `notebooks.copy.gz` | (present) | |
| `samples.copy.gz` | (present) | |
| `audit_trail.copy.gz`, `entry_attachments.copy.gz`, `methods.copy.gz`, `results.copy.gz` | (present) | |

**Spot-check of an entry row** (`entries.copy.gz` row 1):
- `campaign_id`: `NCE-1234-ofat-4` (matches CLAUDE.md "10 OFAT campaigns")
- `family`: `sn_ar` (one of "10 chemistry families")
- `conditions`: structured JSON with acid, base, catalyst, ligand,
  solvent, temperature_c, time_h, scale_mg
- `freetext`: real-shaped ELN procedure — "Procedure: sn_ar on 2000 mg
  scale. The starting material was dissolved in anhydrous toluene…"
- `outcome_status`: `completed`, `yield_pct: 89.87`

**This is genuinely realistic data.** CLAUDE.md's claim of "≥ 2000
deterministic experiments across 4 projects, 10 chemistry families,
10 OFAT campaigns" is **substantively true** (4228 entries observed
exceeds the 2000 floor).

### `test-fixtures/fake_logs/world-default/`

| File | Rows |
|---|---:|
| `datasets.csv` | 3001 (header + 3000 datasets) |
| `dataset_files.csv` | 3001 |
| `tracks.csv` | 1711 |
| `persons.csv` | 51 |

CLAUDE.md says "~3000 datasets" — verified.

### Conclusion on fixtures

The `mock_eln` and `fake_logs` fixtures are the **strongest part** of
the test infrastructure — they would catch real schema-drift bugs if
any test actually loaded them into Postgres. **Today, no test does**
(the `mcp_eln_local` and `mcp_logs_sciy` test suites stub the DB
backend entirely). The fixtures sit unused by the test harness.

---

## CI Configuration Audit

`.github/workflows/ci.yml` — three jobs.

### Job: `typescript` (lines 16-65)

- ESLint + vitest + tsc + npm audit
- Coverage enforced via diff-cover with **75% gate on non-routes** and
  **60% gate on routes** (lines 47, 60). Configured per
  `docs/review/2026-04-29-codebase-audit/05-coverage-baseline.md §8`.
- **Diff-cover only runs on pull_request** (line 51 `if: github.event_name == 'pull_request'`).
  A direct push to main bypasses coverage enforcement entirely.
- No explicit `services:` for Docker / Postgres — relies on the
  ubuntu-latest runner image.

### Job: `python` (lines 67-175)

- Ruff + pytest + mypy + diff-cover
- **Pytest runs an explicit allowlist** (lines 95-102):
  ```
  tests/unit/test_redactor.py
  tests/unit/optimizer/test_session_purger.py
  services/mcp_tools/common/tests/
  services/projectors/kg_source_cache/tests/
  services/projectors/conditions_normalizer/tests/
  services/mcp_tools/mcp_applicability_domain/tests/
  services/mcp_tools/mcp_green_chemistry/tests/
  ```
- Every other Python test directory — `services/queue/tests/`,
  `services/workflow_engine/tests/`, `services/mcp_tools/mcp_eln_local/tests/`,
  `services/mcp_tools/mcp_logs_sciy/tests/`, `services/projectors/qm_kg/tests/`,
  `services/projectors/compound_fingerprinter/tests/`, the rest of
  `tests/unit/`, all `tests/integration/` (gated on env regardless) —
  is **NOT EXECUTED BY CI**. Test rot is invisible.
- **Mypy is on a clean subset** (lines 110-163). 5 services explicitly
  excluded with comments naming pre-existing debt.
- **Diff-cover excludes** `services/queue/**`,
  `services/projectors/kg_hypotheses/**`,
  `services/mcp_tools/mcp_drfp/**`, `services/mcp_tools/mcp_rdkit/**`,
  `services/optimizer/session_reanimator/**`,
  `services/ingestion/eln_json_importer.legacy/**`. The queue and KG
  hypotheses projector are the highest-risk new code — explicitly
  carved out.

### Job: `schema` (lines 177-206)

- Postgres-in-services healthcheck; applies `db/init/*.sql` twice for
  idempotency. **Good** — this is how schema regressions are caught
  even though no integration test touches the schema.

### `.pre-commit-config.yaml`

- ruff (auto-fix), mypy (clean subset only — same as CI), eslint, detect-secrets
- **No pytest in pre-commit** (deliberate — too slow). Pre-commit
  cannot catch a broken test that compiles cleanly.

### CI tripwires identified

1. **`tests/unit/` is partially run.** Eight tests in `test_mcp_doc_fetcher.py`
   plus four in tabicl files have been broken since some prior refactor;
   CI's allowlist meant nobody noticed. **Severity: HIGH** — the
   `_ip_is_blocked → ip_is_blocked` rename is exactly the kind of bug
   the test was written to prevent.
2. **Diff-cover on push-to-main is disabled** (`if: github.event_name == 'pull_request'`).
   A direct merge / force-push bypasses coverage enforcement.
3. **No CI job exercises the integration trio.** The TS job runs
   `npm test` which includes integration files, but `describe.skipIf(!dockerAvailable)`
   silently skips when the runner image's Docker shifts. No assertion
   that the trio actually ran.
4. **`make test` segfaults** (xgboost+torch). CI sidesteps but a local
   developer running `make test` to "check before pushing" sees a crash.
5. **Coverage floors are diff-cover only** — no absolute floor on the
   total. A new file at 0% is acceptable so long as the diff coverage
   on the PR is high enough.

---

## Cross-Reference: Prior Audit (`docs/review/2026-04-29-codebase-audit/05-coverage-baseline.md`)

| Prior finding | Status today |
|---|---|
| `services/agent-claw/src/**` 75.66% statement coverage | Marginally improved; from 775 to 1072 tests (+38%). Coverage by file not re-measured. |
| `services/paperclip/src/**` 56.66% statement coverage | 23 tests today (was 17). |
| `services/**/*.py` ~63% combined | Not re-measured here. The audit's "zero-test list" (`session_reanimator`, `mcp_drfp`, `mcp_rdkit`, `forged_tool_validator/runner.py`, `skill_promoter/runner.py`, `kg_hypotheses` projector) is largely **unchanged**. New zero-test surfaces have been added: `mcp_kg`, `mcp_embedder` (still zero per W6 audit). |
| `routes/chat.ts` 56.9% statement coverage | After the W2 split into `chat-*.ts` siblings, the coverage shape has changed — but no individual route file gets a dedicated unit test for `eval`, `optimizer`, `forged-tools`, `sessions-handlers`, `chat-non-streaming`, `chat-paperclip`, `chat-setup`, `chat-shadow-eval`, `chat-slash`, `documents`, `chat-compact`, `chat-helpers` (per W5). |
| Six projectors with thin coverage | Still thin. New projectors merged since (`compound_fingerprinter`, `compound_classifier`, `qm_kg`, `kg_source_cache`) added a small number of unit tests; no integration tests against real Postgres. |

**New since 2026-04-29:**
- Workflow engine added with **only 4 helper tests** despite being
  the core of Phase 8.
- Queue worker added with **zero correctness-invariant tests**.
- Z-series chemistry MCPs each got 7-21 tests — better than the prior
  baseline for new merges, but still mock-heavy.
- The integration trio (etag/chained/reanimator) added — first real
  testcontainer-backed tests in the repo.
- Golden set fixtures added but not wired to a runner; entries are
  placeholder-quality.
- CI workflow now exists; diff-cover gates added.

---

## Closing Verdict

The suite reports passing tests in volumes that overstate what is
actually verified. **The two Wave-1 defects (`kg_source_cache` UUID
cast, `services/workflow_engine` placeholder mismatch) are not
anomalies** — they are representative of a structural bias. Every
DB-touching code path is mocked at the test boundary; the code exists
in a separate universe from the schema until production traffic hits.

The path forward is not "more tests." It is **fewer mocks at the
DB boundary** for code that *only matters* at the DB boundary. Three
testcontainer-backed integration tests already exist and work — the
pattern is in place. Extending it to the source-cache hook → projector
loop, the workflow engine's `_advance_run`, and the queue worker's
`_lease_one` would catch the next analogous Wave-1 defect before merge.
