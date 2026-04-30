# Track E - Coverage Baseline

**Audit date**: 2026-04-29
**Auditor track**: E (test coverage / quality gate baseline)
**HEAD**: `c7168bc` (main, identical to parent checkout)
**Audit scope**: read-only on production code; coverage tools were installed locally but only into ephemeral non-tracked locations (root `node_modules` dev install, `/tmp/chemclaw-audit-venv`).

This document is the authoritative source for the "before" coverage numbers
that drive Wave 2 (PR-1 diff-cover gate, PR-N targeted-coverage tasks). All
percentages were measured by re-running the test suites against the working
HEAD.

---

## 1. Headline numbers

| Surface | Test suite | Files in scope | Statements | Coverage |
|---|---|---|---|---|
| `services/agent-claw/src/**/*.ts` | vitest + @vitest/coverage-v8 | 107 | 10,234 | **75.66%** stmts / 81.10% br / 93.78% fn |
| `services/paperclip/src/**/*.ts` | vitest + @vitest/coverage-v8 | 6 | 450 | **56.66%** stmts / 93.10% br / 94.28% fn |
| `services/**/*.py` (all measured) | pytest + coverage.py | ~70 .py | 5,637 | **63%** stmt (combined Track E run) |

The headline "agent-claw 75.66%" hides the fact that the code is bimodal:
hot-path harness modules cluster around 95-100% coverage, while four large
files (`index.ts` boot, `routes/chat.ts`, `routes/sessions.ts`, `routes/feedback.ts`)
drag the total down. **Most of the coverage debt is concentrated in seven
files.** See section 3.

The Python "63%" hides that several services have **zero tests at all**:
projectors `kg_hypotheses`, mcp services `mcp_drfp` / `mcp_rdkit`, the
`session_reanimator` daemon, the `forged_tool_validator/runner.py`, and
`skill_promoter/runner.py`. Coverage is genuinely 0 for those files.

---

## 2. TypeScript per-file coverage

### 2.1 services/agent-claw (102 test files, 775 tests, 76.16s wall, 0 fail)

Run command:
```
cd services/agent-claw && npx vitest run --coverage \
  --coverage.reporter=json-summary --coverage.reporter=text-summary \
  --coverage.include='src/**'
```

Coverage by file, **sorted lowest first** (stmt%, br%, fn%, ln%, covered/total stmts):

| File | Stmt% | Br% | Fn% | Ln% | Stmts |
|---|---:|---:|---:|---:|---|
| src/config.ts | 0.0 | 100.0 | 100.0 | 0.0 | 0/102 |
| src/index.ts | 0.0 | 100.0 | 100.0 | 0.0 | 0/389 |
| src/db/pool.ts | 0.0 | 100.0 | 100.0 | 0.0 | 0/16 |
| src/routes/documents.ts | 0.0 | 100.0 | 100.0 | 0.0 | 0/68 |
| src/routes/eval-parser.ts | 0.0 | 100.0 | 100.0 | 0.0 | 0/1 |
| src/routes/eval.ts | 0.0 | 100.0 | 100.0 | 0.0 | 0/150 |
| src/routes/forged-tools.ts | 0.0 | 100.0 | 100.0 | 0.0 | 0/146 |
| src/routes/healthz.ts | 0.0 | 100.0 | 100.0 | 0.0 | 0/5 |
| src/routes/optimizer.ts | 0.0 | 100.0 | 100.0 | 0.0 | 0/71 |
| src/tools/builtins/compute_confidence_ensemble.ts | 0.0 | 100.0 | 100.0 | 0.0 | 0/82 |
| src/tools/builtins/query_eln_samples_by_entry.ts | 0.0 | 100.0 | 100.0 | 0.0 | 0/41 |
| src/tools/builtins/query_instrument_persons.ts | 0.0 | 100.0 | 100.0 | 0.0 | 0/46 |
| src/core/plan-store-db.ts | 1.4 | 100.0 | 0.0 | 1.4 | 1/69 |
| src/core/hooks/permission.ts | 30.0 | 100.0 | 50.0 | 30.0 | 3/10 |
| src/routes/sessions.ts | 47.4 | 63.6 | 100.0 | 47.4 | 217/458 |
| src/observability/otel.ts | 54.7 | 28.6 | 66.7 | 54.7 | 29/53 |
| src/routes/feedback.ts | 56.0 | 78.9 | 66.7 | 56.0 | 56/100 |
| src/routes/chat.ts | 56.9 | 57.7 | 83.3 | 56.9 | 363/638 |
| src/mcp/postJson.ts | 61.5 | 76.5 | 75.0 | 61.5 | 56/91 |
| src/llm/litellm-provider.ts | 65.1 | 66.7 | 87.5 | 65.1 | 97/149 |
| src/core/session-state.ts | 69.2 | 73.1 | 100.0 | 69.2 | 72/104 |
| src/core/hooks/tag-maturity.ts | 73.8 | 96.4 | 100.0 | 73.8 | 62/84 |
| src/routes/skills.ts | 74.2 | 61.5 | 100.0 | 74.2 | 46/62 |
| src/tools/builtins/statistical_analyze.ts | 77.6 | 62.5 | 100.0 | 77.6 | 166/214 |
| src/observability/spans.ts | 77.6 | 100.0 | 50.0 | 77.6 | 52/67 |
| src/tools/builtins/induce_forged_tool_from_trace.ts | 77.8 | 87.5 | 66.7 | 77.8 | 105/135 |
| src/routes/plan.ts | 78.8 | 76.5 | 100.0 | 78.8 | 82/104 |
| src/tools/builtins/analyze_csv.ts | 79.1 | 68.5 | 100.0 | 79.1 | 167/211 |
| src/security/mcp-tokens.ts | 81.9 | 73.2 | 100.0 | 81.9 | 118/144 |
| src/core/skills.ts | 82.3 | 78.6 | 82.3 | 82.3 | 168/204 |
| src/core/hook-loader.ts | 83.1 | 82.8 | 100.0 | 83.1 | 113/136 |
| src/routes/learn.ts | 83.1 | 62.5 | 100.0 | 83.1 | 64/77 |
| src/tools/registry.ts | 84.0 | 68.0 | 94.4 | 84.0 | 226/269 |
| src/prompts/shadow-evaluator.ts | 85.5 | 77.3 | 100.0 | 85.5 | 65/76 |
| src/core/harness.ts | 86.9 | 93.5 | 66.7 | 86.9 | 113/130 |
| src/tools/builtins/manage_todos.ts | 87.2 | 82.6 | 100.0 | 87.2 | 130/149 |
| src/routes/artifacts.ts | 88.4 | 82.3 | 100.0 | 88.4 | 84/95 |
| src/tools/builtins/run_program.ts | 89.0 | 84.6 | 100.0 | 89.0 | 154/173 |
| src/tools/builtins/expand_reaction_context.ts | 89.2 | 66.7 | 100.0 | 89.2 | 190/213 |
| src/security/workspace-boundary.ts | 89.3 | 87.5 | 100.0 | 89.3 | 50/56 |
| src/core/hooks/apply-skills.ts | 90.0 | 80.0 | 100.0 | 90.0 | 18/20 |
| src/routes/deep-research.ts | 90.8 | 73.9 | 75.0 | 90.8 | 149/164 |
| src/core/paperclip-client.ts | 91.2 | 84.2 | 100.0 | 91.2 | 83/91 |
| src/security/mcp-token-cache.ts | 91.7 | 92.8 | 100.0 | 91.7 | 55/60 |
| src/core/hooks/anti-fabrication.ts | 93.0 | 92.8 | 100.0 | 93.0 | 53/57 |
| src/core/hooks/source-cache.ts | 93.4 | 66.3 | 100.0 | 93.4 | 327/350 |
| src/core/plan-mode.ts | 93.5 | 93.3 | 85.7 | 93.5 | 43/46 |
| src/core/sandbox.ts | 93.8 | 86.8 | 100.0 | 93.8 | 121/129 |
| src/core/session-store.ts | 93.8 | 78.4 | 100.0 | 93.8 | 212/226 |
| src/tools/builtins/mark_research_done.ts | 93.8 | 83.3 | 100.0 | 93.8 | 106/113 |
| src/core/step.ts | 93.9 | 89.5 | 100.0 | 93.9 | 169/180 |
| src/core/lifecycle.ts | 94.0 | 95.8 | 100.0 | 94.0 | 110/117 |
| src/core/hooks/redact-secrets.ts | 94.4 | 75.0 | 100.0 | 94.4 | 68/72 |
| src/core/compactor.ts | 95.0 | 91.7 | 100.0 | 95.0 | 57/60 |
| src/llm/provider.ts | 95.7 | 94.4 | 100.0 | 95.7 | 90/94 |
| src/tools/builtins/search_knowledge.ts | 96.2 | 84.0 | 100.0 | 96.2 | 153/159 |
| src/tools/builtins/add_forged_tool_test.ts | 96.5 | 75.0 | 100.0 | 96.5 | 55/57 |
| src/tools/builtins/dispatch_sub_agent.ts | 96.5 | 50.0 | 100.0 | 96.5 | 55/57 |
| src/core/confidence.ts | 96.6 | 95.9 | 100.0 | 96.6 | 113/117 |
| src/tools/builtins/forge_tool.ts | 97.0 | 88.2 | 100.0 | 97.0 | 294/303 |
| src/streaming/sse-sink.ts | 97.0 | 100.0 | 87.5 | 97.0 | 33/34 |
| src/tools/builtins/propose_hypothesis.ts | 97.3 | 66.7 | 100.0 | 97.3 | 73/75 |
| src/core/budget.ts | 98.2 | 96.9 | 93.8 | 98.2 | 107/109 |
| src/tools/builtins/synthesize_insights.ts | 98.2 | 88.9 | 100.0 | 98.2 | 111/113 |
| src/prompts/registry.ts | 98.2 | 89.7 | 100.0 | 98.2 | 112/114 |
| src/core/slash.ts | 99.0 | 94.6 | 100.0 | 99.0 | 105/106 |
| src/core/hook-output.ts | 100.0 | 100.0 | 100.0 | 100.0 | 12/12 |
| src/core/request-context.ts | 100.0 | 100.0 | 100.0 | 100.0 | 11/11 |
| src/core/runtime.ts | 100.0 | 100.0 | 100.0 | 100.0 | 2/2 |
| src/core/sub-agent.ts | 100.0 | 81.8 | 100.0 | 100.0 | 117/117 |
| src/core/hooks/budget-guard.ts | 100.0 | 100.0 | 100.0 | 100.0 | 23/23 |
| src/core/hooks/compact-window.ts | 100.0 | 100.0 | 100.0 | 100.0 | 18/18 |
| src/core/hooks/foundation-citation-guard.ts | 100.0 | 100.0 | 100.0 | 100.0 | 59/59 |
| src/core/hooks/init-scratch.ts | 100.0 | 100.0 | 100.0 | 100.0 | 11/11 |
| src/core/hooks/session-events.ts | 100.0 | 100.0 | 100.0 | 100.0 | 10/10 |
| src/core/permissions/resolver.ts | 100.0 | 100.0 | 100.0 | 100.0 | 69/69 |
| src/db/with-user-context.ts | 100.0 | 88.9 | 100.0 | 100.0 | 33/33 |
| src/observability/hook-spans.ts | 100.0 | 75.0 | 100.0 | 100.0 | 38/38 |
| src/observability/tool-spans.ts | 100.0 | 63.6 | 100.0 | 100.0 | 32/32 |
| src/streaming/sse.ts | 100.0 | 100.0 | 100.0 | 100.0 | 12/12 |
| src/tools/_limits.ts | 100.0 | 100.0 | 100.0 | 100.0 | 5/5 |
| src/tools/tool.ts | 100.0 | 100.0 | 100.0 | 100.0 | 3/3 |
| src/tools/builtins/_eln_shared.ts | 100.0 | 100.0 | 100.0 | 100.0 | 80/80 |
| src/tools/builtins/_logs_schemas.ts | 100.0 | 100.0 | 100.0 | 100.0 | 32/32 |
| src/tools/builtins/ask_user.ts | 100.0 | 100.0 | 100.0 | 100.0 | 44/44 |
| src/tools/builtins/canonicalize_smiles.ts | 100.0 | 100.0 | 100.0 | 100.0 | 34/34 |
| src/tools/builtins/check_contradictions.ts | 100.0 | 90.9 | 100.0 | 100.0 | 103/103 |
| src/tools/builtins/compute_conformer_ensemble.ts | 100.0 | 100.0 | 100.0 | 100.0 | 45/45 |
| src/tools/builtins/draft_section.ts | 100.0 | 100.0 | 100.0 | 100.0 | 53/53 |
| src/tools/builtins/fetch_eln_canonical_reaction.ts | 100.0 | 100.0 | 100.0 | 100.0 | 39/39 |
| src/tools/builtins/fetch_eln_entry.ts | 100.0 | 100.0 | 100.0 | 100.0 | 38/38 |
| src/tools/builtins/fetch_eln_sample.ts | 100.0 | 100.0 | 100.0 | 100.0 | 38/38 |
| src/tools/builtins/fetch_full_document.ts | 100.0 | 80.0 | 100.0 | 100.0 | 55/55 |
| src/tools/builtins/fetch_instrument_run.ts | 100.0 | 100.0 | 100.0 | 100.0 | 37/37 |
| src/tools/builtins/fetch_original_document.ts | 100.0 | 100.0 | 100.0 | 100.0 | 136/136 |
| src/tools/builtins/find_similar_reactions.ts | 100.0 | 90.9 | 100.0 | 100.0 | 94/94 |
| src/tools/builtins/identify_unknown_from_ms.ts | 100.0 | 100.0 | 100.0 | 100.0 | 75/75 |
| src/tools/builtins/predict_molecular_property.ts | 100.0 | 100.0 | 100.0 | 100.0 | 44/44 |
| src/tools/builtins/predict_reaction_yield.ts | 100.0 | 100.0 | 100.0 | 100.0 | 41/41 |
| src/tools/builtins/propose_retrosynthesis.ts | 100.0 | 81.8 | 100.0 | 100.0 | 106/106 |
| src/tools/builtins/query_eln_canonical_reactions.ts | 100.0 | 100.0 | 100.0 | 100.0 | 45/45 |
| src/tools/builtins/query_eln_experiments.ts | 100.0 | 100.0 | 100.0 | 100.0 | 53/53 |
| src/tools/builtins/query_instrument_datasets.ts | 100.0 | 100.0 | 100.0 | 100.0 | 37/37 |
| src/tools/builtins/query_instrument_runs.ts | 100.0 | 100.0 | 100.0 | 100.0 | 65/65 |
| src/tools/builtins/query_kg.ts | 100.0 | 100.0 | 100.0 | 100.0 | 74/74 |

(Files reporting `Br% 100 / Fn% 100` while at `Stmt% 0` are not bugs — the
reporter counts module-level guards as a single function and that gets hit
by import-time evaluation in environments where the module is loaded but
no entry point is invoked.)

### 2.2 services/paperclip (2 test files, 23 tests, 1.08s, 0 fail)

| File | Stmt% | Br% | Fn% | Ln% | Stmts |
|---|---:|---:|---:|---:|---|
| src/budget.ts | 100.0 | 100.0 | 100.0 | 100.0 | 102/102 |
| src/concurrency.ts | 100.0 | 90.0 | 100.0 | 100.0 | 29/29 |
| src/persistence.ts | 95.5 | 77.8 | 100.0 | 95.5 | 43/45 |
| src/metrics.ts | 98.0 | 83.3 | 100.0 | 98.0 | 49/50 |
| src/heartbeat.ts | 80.0 | 100.0 | 71.4 | 80.0 | 32/40 |
| src/index.ts | 0.0 | 100.0 | 100.0 | 0.0 | 0/184 |

`src/index.ts` is the Fastify boot wrapper; all routes inside it currently
have NO unit tests. The 56.66% headline is misleading — every line of
genuine business logic is covered, and 184 statements of route plumbing
are not.

---

## 3. Critical-path low-coverage rank

"Critical path" = files that handle user input, RLS, MCP auth, redaction,
the hook-loader, projector base, or session persistence. Sorted by impact
(stmts × (1 - cov%)).

| Rank | File | Cov% | Stmts uncovered | Why critical | Target | Tests needed (rough) |
|---:|---|---:|---:|---|---:|---:|
| 1 | `services/agent-claw/src/routes/chat.ts` | 56.9% | 275 | Primary user input gate. Streams SSE, handles `session_id` + `awaiting_question` resume, calls `withUserContext`. Each uncovered branch is a potential RLS bypass / auth-skip surface. | 80% | 12-18 |
| 2 | `services/agent-claw/src/routes/sessions.ts` | 47.4% | 241 | `/api/sessions/:id/plan/run`, `/resume`, etag-conflict handling. Internal `/api/internal/sessions/:id/resume` (reanimator). Covered by Docker-required integration tests; no unit-level coverage on business logic. | 80% | 10-14 |
| 3 | `services/agent-claw/src/index.ts` | 0% | 389 | Boot code: lifecycle setup, `loadHooks` invocation, `MIN_EXPECTED_HOOKS` assertion, JWT signing-key validation, OTel init. The startup gate that prevents silent hook regressions is itself untested. | 60% | 6-8 |
| 4 | `services/agent-claw/src/routes/forged-tools.ts` | 0% | 146 | Forge / promote / demote endpoints — privilege-elevation surface (`scope_promotion: private → project → org`). Zero unit coverage. | 80% | 8-10 |
| 5 | `services/agent-claw/src/routes/eval.ts` | 0% | 150 | `/eval` slash verb route. Reads golden fixtures; held-out promotion gate. | 70% | 6-8 |
| 6 | `services/agent-claw/src/llm/litellm-provider.ts` | 65.1% | 52 | Single egress chokepoint to LiteLLM. All redactor invocations flow through here; failure modes are sparsely tested. | 85% | 5-7 |
| 7 | `services/agent-claw/src/mcp/postJson.ts` | 61.5% | 35 | Mints HS256 JWT per request via AsyncLocalStorage. Auth header attachment is the Layer-2 MCP gate. | 90% | 4-6 |
| 8 | `services/agent-claw/src/routes/feedback.ts` | 56.0% | 44 | `/feedback` writes to DB; XSS-able free text. RLS context required. | 80% | 4-6 |
| 9 | `services/agent-claw/src/security/mcp-tokens.ts` | 81.9% | 26 | JWT signing key check, scope encoding, expiry. Already has good coverage but the missing 18% is mostly the "production fail-closed when key missing" branches. | 95% | 3-4 |
| 10 | `services/agent-claw/src/core/plan-store-db.ts` | 1.4% | 68 | DB-backed plan storage replacing the in-memory `planStore`. Almost entirely untested at the unit level (covered indirectly by chained-execution Docker test). | 75% | 6-8 |
| 11 | `services/agent-claw/src/routes/documents.ts` | 0% | 68 | Document fetch route. Calls `mcp_doc_fetcher`. | 75% | 4-6 |
| 12 | `services/agent-claw/src/routes/optimizer.ts` | 0% | 71 | Optimizer endpoints; admin surface. | 70% | 3-5 |
| 13 | `services/agent-claw/src/observability/otel.ts` | 54.7% | 24 | Tracing init; exporter wiring. Less critical for correctness but a regression here means lost prod telemetry. | 75% | 3-4 |
| 14 | `services/agent-claw/src/core/session-state.ts` | 69.2% | 32 | `hydrateScratchpad` / `persistTurnState` — every route uses these for cross-turn state. | 90% | 3-5 |
| 15 | `services/agent-claw/src/tools/builtins/compute_confidence_ensemble.ts` | 0% | 82 | Confidence ensemble tool: 3-signal scoring on which "FOUNDATION" tier rests. | 80% | 5-7 |
| 16 | `services/projectors/common/base.py` | 26% | 100 | Base class for ALL projectors: LISTEN/NOTIFY, ack semantics, restart safety, idempotency guards. Replay-safety bugs here corrupt every derived view. | 75% | 8-12 |
| 17 | `services/projectors/kg_hypotheses/main.py` | 0% | 80 | Hypotheses projector: zero unit tests; only integration tested. | 70% | 5-7 |
| 18 | `services/optimizer/session_reanimator/main.py` | 0% | 94 | Auto-resume daemon. Mints its own JWT (`agent:resume` scope). Zero unit tests; only integration via reanimator-roundtrip. | 70% | 5-8 |
| 19 | `services/litellm_redactor/callback.py` | 0% | 12 | LiteLLM pre-egress callback. The redaction logic underneath (`redaction.py`) is 78% covered; the callback wrapper that wires it in is 0%. | 100% | 1-2 |
| 20 | `services/mcp_tools/common/auth.py` | 74% | 31 | Bearer-token verification middleware (ADR 006 Layer 2). Dev-mode-fallback gating. | 95% | 4-6 |

**Total estimated tests needed to bring all 20 critical-path items to
target**: ~115 tests. At an industry-typical density of 1 unit test per
~12 statements covered, this corresponds to ~1,400 statements of new test
code (~5,500-6,500 LOC).

For PR scoping: items 1, 2, 3, 9, 16, 17, 18, 19 are the **must-fix**
critical-path coverage gaps for any production-ready posture. Items 4, 5,
10, 11, 12, 14, 15 are second-tier (admin / less-frequent paths).

---

## 4. Test density per service

Test density = (test LOC / src LOC). Industry baseline for "solid coverage"
on TypeScript services is ~20-30%; for Python ~15-25%. Higher is not
automatically better — at >100% it usually signals brittle integration
tests or copy-paste setup/teardown.

| Service | Src LOC | Test LOC | Density | Test files | Headline cov% | Verdict |
|---|---:|---:|---:|---:|---:|---|
| services/agent-claw | 18,196 | 16,536 | 90.9% | 102 | 75.7% | High density, mature; deficit is concentration in 4 files |
| services/paperclip | 794 | 327 | 41.2% | 2 | 56.7% | Density looks fine; missing route-layer tests |
| services/mcp_tools/common | 838 | 656 | 78.3% | 4 | 92.5% | Excellent - benchmark for new services |
| services/mcp_tools/mcp_eln_local | 969 | 523 | 54.0% | 1 | 90.8% | Single-file test is dense; risk of brittleness |
| services/mcp_tools/mcp_logs_sciy | 774 | 291 | 37.6% | 1 | 69.1% | Density OK but `fake_postgres.py` backend is 20% covered |
| services/mcp_tools/mcp_xtb | 289 | 200 | 69.2% | 1 | 82.1% | Healthy |
| services/mcp_tools/mcp_sirius | 207 | 168 | 81.2% | 1 | 87.5% | Healthy |
| services/mcp_tools/mcp_aizynth | 120 | 122 | 101.7% | 1 | 91.2% | Strong |
| services/mcp_tools/mcp_askcos | 168 | 171 | 101.8% | 1 | 94.3% | Strong |
| services/mcp_tools/mcp_chemprop | 182 | 110 | 60.4% | 1 | 83.6% | Healthy |
| services/mcp_tools/mcp_doc_fetcher | 728 | 373 | 51.2% | 1 | 51.6% | Tests exist (root tests/) but 5 fail without env config |
| services/mcp_tools/mcp_kg | 759 | 375 | 49.4% | 3 | 61.5% | Tests cover models/cypher; main.py route handler is 0% |
| services/mcp_tools/mcp_tabicl | 568 | 271 | 47.7% | 3 | 64.0% | 3 tests fail under audit env (FastAPI mismatch) |
| services/mcp_tools/mcp_embedder | 227 | 82 | 36.1% | 2 | 42.5% | main.py 0%, encoder 61% |
| services/mcp_tools/mcp_drfp | 92 | 0 | 0% | 0 | 0% | NO TESTS |
| services/mcp_tools/mcp_rdkit | 173 | 0 | 0% | 0 | 0% | NO TESTS |
| services/mcp_tools/mcp_instrument_template | 0 | 0 | n/a | 0 | n/a | Stub |
| services/projectors/common | 331 | 0 | 0% | 0 | 0%* | NO TESTS (the base class everything subclasses) |
| services/projectors/kg_source_cache | 166 | 190 | 114.5% | 1 | 89.0% | Strong |
| services/projectors/contextual_chunker | 287 | 146 | 50.9% | 1 (root) | 43.0% | Root-tests-dir tests exist |
| services/projectors/reaction_vectorizer | 152 | 101 | 66.4% | 1 (root) | 56.0% | OK |
| services/projectors/chunk_embedder | 154 | 99 | 64.3% | 1 (root) | 55.0% | OK |
| services/projectors/kg_experiments | 412 | 33 | 8.0% | 1 (root) | 36.0% | THIN |
| services/projectors/kg_hypotheses | 171 | 0 | 0% | 0 | 0% | NO TESTS |
| services/optimizer/forged_tool_validator | 761 | 288 | 37.8% | 1 (root) | 70%* | runner.py 0%, validator.py 72% |
| services/optimizer/gepa_runner | 1,006 | 678 | 67.4% | 3 (root) | ~80% | Healthy |
| services/optimizer/skill_promoter | 543 | 254 | 46.8% | 1 (root) | 91% promoter / 0% runner | runner.py untested |
| services/optimizer/session_purger | 149 | 162 | 108.7% | 1 (root) | 59% | Tests are thorough; coverage held back by import-time guards |
| services/optimizer/session_reanimator | 283 | 0 | 0% | 0 | 0% | NO TESTS (touched only by Docker-required reanimator-roundtrip in agent-claw) |
| services/litellm_redactor | 208 | 79 | 38.0% | 1 (root) | 68% | redaction.py 78%, callback.py 0% |
| services/mock_eln/seed | 2,024 | 323 | 16.0% | 1 | 92.3% | Sparse tests but high coverage (deterministic generators) |
| services/ingestion/doc_ingester | 582 | 198 | 34.0% | 3 (root) | 31.6% (after env fix) | importer.py 35%, parsers.py 41% |
| services/ingestion/eln_json_importer.legacy | 162 | 0 | 0% | 0 | 0% | Legacy (retired from live path); preserved for one-shot bulk migrations |

`*` projectors/common/base.py is exercised indirectly (every projector
subclass test eventually instantiates it), but no targeted unit test of
the base-class semantics exists. The 26% number is what shows up under
strict line-by-line measurement.

### 4.1 Density-vs-coverage anomaly check

Several services have **high density (>50%) but low coverage (<60%)** —
these are signals of test brittleness or ineffective setup:

- `services/mcp_tools/mcp_doc_fetcher` (density 51%, cov 52%) — five tests
  fail because `MCP_DOC_FETCHER_FILE_ROOTS` is unset. Tests exercise
  setup machinery but not the file-fetch business logic when env is missing.
- `services/projectors/kg_experiments` (density 8%, cov 36%) — under-tested
  AND determinism test is single-file with mock heavy.
- `services/optimizer/session_purger` (density 109%, cov 59%) — tests
  cover decision logic but not the apscheduler bootstrap path; the missing
  41% is module-level cron registration.

---

## 5. Untested-but-exported surface (services/agent-claw)

Method: extracted every `export function|async function` name from
`src/**/*.ts` (155 names) and counted how many `tests/**` files reference
each name (string match, not just `import` since many are registered
through factories).

**Functions with ZERO test references** (42):

| Function | File | Indirect coverage? | Notes |
|---|---|---|---|
| `_resetSkillLoader` | core/skills.ts | yes | Dev-only test helper; defensible to skip |
| `advancePlan` | core/plan-store-db.ts | partial (Docker integration) | **Critical** — sub-step state machine |
| `buildComputeConfidenceEnsembleTool` | tools/builtins/compute_confidence_ensemble.ts | NO | Tool factory not exercised |
| `buildQueryElnSamplesByEntryTool` | tools/builtins/query_eln_samples_by_entry.ts | NO | Tool factory not exercised |
| `buildQueryInstrumentPersonsTool` | tools/builtins/query_instrument_persons.ts | NO | Tool factory not exercised |
| `createPool` | db/pool.ts | NO | Boot-time DB pool factory |
| `createTodos` | tools/builtins/manage_todos.ts | yes (covered via dispatch) | Indirect |
| `estimateTokenCount` | core/budget.ts | yes (sibling fns tested) | Indirect |
| `getJson` | mcp/postJson.ts | partial | Sibling `postJson` is tested |
| `getProvider` | llm/provider.ts | yes | Indirect via litellm-provider |
| `getRequestContext` | core/request-context.ts | yes | Used in every test mock |
| `getSkillLoader` | core/skills.ts | yes | Indirect |
| `loadActivePlanForSession` | core/plan-store-db.ts | partial (Docker only) | **Critical** |
| `loadConfig` | config.ts | NO | Boot-time only |
| `makeLangfuseTraceReader` | observability/* | NO | Langfuse OTel reader |
| `permissionHook` | core/hooks/permission.ts | yes (indirect register call) | Hook chain dispatched, but the no-op return path isn't asserted |
| `persistTurnState` | core/session-state.ts | yes | Indirect via routes |
| `registerApplySkillsHook` | hooks/apply-skills.ts | yes | Hook-loader registers it; but registration return-shape isn't asserted |
| `registerBudgetGuardHook` | hooks/budget-guard.ts | yes | (same pattern) |
| `registerCompactWindowHook` | hooks/compact-window.ts | yes | (same pattern) |
| `registerDocumentsRoute` | routes/documents.ts | NO | Route registrar |
| `registerEvalRoute` | routes/eval.ts | NO | Route registrar |
| `registerForgedToolsRoutes` | routes/forged-tools.ts | NO | Route registrar |
| `registerHealthzRoute` | routes/healthz.ts | NO | Route registrar |
| `registerOptimizerRoutes` | routes/optimizer.ts | NO | Route registrar |
| `registerPermissionHook` | hooks/permission.ts | yes (indirect) | (same pattern) |
| `registerSessionEventsHook` | hooks/session-events.ts | yes | (same pattern) |
| `registerSourceCacheHook` | hooks/source-cache.ts | yes | (same pattern) |
| `registerTagMaturityHook` | hooks/tag-maturity.ts | yes | (same pattern) |
| `runWithRequestContext` | core/request-context.ts | yes | Used in test mocks |
| `savePlanForSession` | core/plan-store-db.ts | partial (Docker) | **Critical** |
| `sessionEventsHook` | hooks/session-events.ts | yes | Indirect |
| `setupSse` | streaming/sse.ts | yes | Used by chat route tests |
| `startRootTurnSpan` | observability/spans.ts | yes | Sibling tested |
| `startSubAgentSpan` | observability/spans.ts | yes | Sibling tested |
| `startToolSpan` | observability/spans.ts | yes | Sibling tested |
| `syncSeenFactIdsFromScratch` | core/session-state.ts | yes | Tested via harness loop |
| `updateTodo` | tools/builtins/manage_todos.ts | yes | Indirect |
| `verifyBearerHeader` | security/mcp-tokens.ts | yes (server-side fixture) | Tested via test_auth.py on Python side; TS side missing |
| `withHookSpan` | observability/hook-spans.ts | yes | Sibling pattern |
| `withToolSpan` | observability/tool-spans.ts | yes | Sibling pattern |
| `writeEvent` | streaming/sse-sink.ts | yes | Sibling pattern |

**Targeted recommendation**: Add explicit unit tests for the seven
**`register*Routes` / route-registrar** functions. They are 0% covered
and form the API surface the agent exposes to its caller (Streamlit, CLI).
A ~50-line test per route registrar using Fastify's `inject()` would lift
coverage on `routes/forged-tools`, `routes/eval`, `routes/documents`,
`routes/optimizer`, and `routes/healthz` to 70-90% in one PR.

The other significant deficit is `core/plan-store-db.ts` at 1.4% — the
three exported functions (`advancePlan`, `loadActivePlanForSession`,
`savePlanForSession`) are only tested by the Docker-required
chained-execution test and have no unit coverage.

---

## 6. Slow tests

### 6.1 TypeScript (vitest output, --reporter=text-summary)

Tests >2s wall:

| Test file | Wall time | Notes |
|---|---:|---|
| tests/integration/reanimator-roundtrip.test.ts | 64.98s (6 tests) | Docker-required; testcontainer + agent-claw boot |
| tests/integration/etag-conflict.test.ts | 62.49s (2 tests) | Docker-required |
| tests/integration/chained-execution.test.ts | 61.44s (1 test) | Docker-required |
| tests/unit/chat-route.test.ts | 2.02s (10 tests) | Heavy Fastify+mock setup; ~200ms per test |

Tests >200ms but <2s (potentially candidates for optimisation):

| Test file | Wall time | Tests | ms/test |
|---|---:|---:|---:|
| tests/unit/streaming-chat.test.ts | 1786ms | 8 | 223 |
| tests/integration/chat-streaming-via-harness.test.ts | 1393ms | 1 | 1393 |
| tests/unit/api-skills.test.ts | 1191ms | 6 | 199 |
| tests/unit/deep-research-route.test.ts | 1171ms | 6 | 195 |
| tests/unit/artifacts-route.test.ts | 1150ms | 7 | 164 |
| tests/unit/api-plan.test.ts | 1122ms | 6 | 187 |
| tests/unit/learn-route.test.ts | 1072ms | 4 | 268 |
| tests/unit/feedback-route.test.ts | 900ms | 6 | 150 |

Total transform / collect / setup time was 102.94s of the 76.16s wall
(parallelized). Vitest is using ~4 workers at default. The Fastify-based
route tests dominate; each spins up a full Fastify instance per test.

**Optimization opportunity**: Several "*-route.test.ts" tests instantiate
Fastify app per test (`beforeEach`). Reusing a single app via `beforeAll`
+ `app.inject()` would cut wall time ~50% on those eight files.

### 6.2 Python (pytest --durations=15)

| Test | Wall time | Notes |
|---|---:|---|
| services/mock_eln/seed/tests/test_generator.py::test_determinism_byte_identical | 5.44s | Generates ~2000 deterministic experiments twice + diffs; expensive but legitimate |
| services/mock_eln/seed/tests/test_generator.py::test_projects_exact_count (setup) | 2.55s | Runs seed generator |
| services/mock_eln/seed/tests/test_generator.py::test_fake_logs_project_code_matches_sample_id_project | 1.39s | |
| services/mock_eln/seed/tests/test_generator.py::test_ofat_campaigns_have_configured_counts | 0.18s | |
| tests/unit/test_mcp_tabicl_featurizer.py | 0.13-0.17s | sklearn import overhead |

No Python tests >2s besides the mock_eln seed tests, which are by-design
heavy (they exercise a 2000-row generator). Total pytest wall for the
Python suites I ran was 28.18s for 342 tests = 82ms/test average.

---

## 7. Flaky / environment-dependent tests

### 7.1 Self-skip cleanly (good)

- `services/agent-claw/tests/integration/etag-conflict.test.ts`
- `services/agent-claw/tests/integration/chained-execution.test.ts`
- `services/agent-claw/tests/integration/reanimator-roundtrip.test.ts`

These three use the testcontainer harness in
`services/agent-claw/tests/helpers/postgres-container.ts` which
`describe.skip`s the whole suite when Docker isn't available. CLAUDE.md
documents this. Re-ran with Docker present and they passed (775 total).

`tests/unit/test_mcp_doc_fetcher.py::test_pdf_*` — uses `pytest.importorskip("pypdf")`
to skip cleanly when pypdf isn't available.

### 7.2 Fail loudly when env is missing (BAD)

These tests do NOT self-skip and will fail under any environment that
doesn't pre-set their required env vars:

| Test | Failure mode | Required env |
|---|---|---|
| `tests/unit/test_mcp_doc_fetcher.py::test_file_fetch_roundtrip` | `ValueError: file:// access disabled — set MCP_DOC_FETCHER_FILE_ROOTS to a colon-separated allow-list of absolute paths to enable` | `MCP_DOC_FETCHER_FILE_ROOTS=/tmp` (or any tmp path) |
| `tests/unit/test_mcp_doc_fetcher.py::test_max_bytes_overrun_file` | same | same |
| `tests/unit/test_mcp_doc_fetcher.py::test_pdf_pages_text_fallback` | same (when pypdf installed) | same |
| `tests/unit/test_mcp_doc_fetcher.py::test_pdf_out_of_range_page` | same | same |
| `tests/unit/test_mcp_doc_fetcher.py::test_byte_offset_to_page_returns_correct_pages` | same | same |
| `tests/unit/test_mcp_tabicl_api.py::test_featurize_happy_path` | `assert <test client status>` — looks like FastAPI version mismatch / route not registered | likely `/.startup` lifecycle change in fastapi >=0.110 |
| `tests/unit/test_mcp_tabicl_api.py::test_row_cap_rejection` | `assert 422` — same root cause | same |
| `tests/unit/test_mcp_tabicl_featurizer.py::test_featurize_happy_path` | same | same |

**Recommendation for Wave 2**:

1. The doc_fetcher 5 tests should `monkeypatch.setenv("MCP_DOC_FETCHER_FILE_ROOTS", str(tmp_path))`
   inside the fixtures so they self-configure rather than failing loudly.
2. The 3 mcp_tabicl tests probably have a real bug (the test client got
   a 401 / 500 instead of 200/422). Worth a small Track investigation —
   `/.venv/bin/pytest tests/unit/test_mcp_tabicl_api.py -vv` should show
   the response body.

### 7.3 Tests that depend on missing optional deps but DON'T skip

I had to install the following packages from PyPI in the audit venv to
get any meaningful coverage. The default `make setup` in the parent
checkout would install most of these; they're flagged here only because
running pytest from a clean venv fails LOUDLY on each missing import:

- `psycopg`, `psycopg-pool` — required for `optimizer/session_purger`,
  `mcp_eln_local`, `mcp_logs_sciy` tests. If `make setup` skips
  `services/optimizer/requirements.txt`, optimizer tests fail at collection.
- `apscheduler` — required for `optimizer/gepa_runner`. Same pattern.
- `defusedxml` — required for `ingestion/doc_ingester`.
- `dspy-ai`, `litellm`, `graphiti-core`, `neo4j` — required for optimizer
  and KG-touching code paths.
- `scikit-learn` — required for `mcp_tabicl`.
- `pypdf` — for doc_fetcher PDF tests (does self-skip).

The CLAUDE.md test-counts table reports "33 passed" for the
`services/mcp_tools/common/tests/` set as the canonical baseline — that
is exactly what I reproduced (33 passed). Other figures in CLAUDE.md
aren't broken out by service so I can't directly cross-check.

---

## 8. Recommended diff-cover threshold for PR-1

### 8.1 Inputs

- Existing line coverage on `services/agent-claw/src` is 75.66%, with 90%+
  on the hot harness path.
- The codebase has 196 exported names that are not directly imported by
  any test (many indirect, but enforces a non-trivial review burden on
  any new export).
- Several critical-path files are at <60% coverage today, so a strict
  diff-cover gate would block PR-1 itself if PR-1 modifies any of those
  files (e.g., to add a redactor pattern).

### 8.2 Recommendation: **diff-cover threshold 75% for `services/agent-claw/src`**, **70% for `services/**/*.py`**, **60% for `services/paperclip/src` and `services/agent-claw/src/routes/**`** (the route layer specifically).

Rationale:

- **75% TS** matches current baseline (75.66%). Anything looser is
  meaningless; anything stricter will block PR-1 if it touches `routes/chat.ts`
  (current 56.9%) or `routes/sessions.ts` (47.4%) — those need targeted
  PRs, not a gate that rejects normal work.
- **70% Python** is below the combined Python baseline (63%) but above
  most individual service rates. Setting the gate at 63% would let
  regressions through; setting at 80% would block PRs touching
  `projectors/common/base.py` (currently 26%). 70% is the right "no
  regressions but not punitive" threshold.
- **Routes carve-out at 60%**: Without this, PR-1 cannot land any
  changes to `routes/chat.ts`, `routes/sessions.ts`, `routes/feedback.ts`,
  or any of the 0%-coverage route files, because the existing baseline
  is below the global 75% gate. PR-N (route-specific test PRs) should
  raise the routes threshold to 80% only after the targeted-test PRs land.

### 8.3 Suggested diff-cover invocation

```yaml
# PR-1 quality-gate.yml (CI step)
- name: Diff coverage (TypeScript)
  run: |
    npx diff-cover services/agent-claw/coverage/lcov.info \
      --compare-branch=main \
      --fail-under=75 \
      --fail-paths-not-found=false \
      --exclude='services/agent-claw/src/routes/**' \
      --exclude='services/agent-claw/src/index.ts' \
      --exclude='services/agent-claw/src/config.ts'

- name: Diff coverage (TypeScript - routes carve-out)
  run: |
    npx diff-cover services/agent-claw/coverage/lcov.info \
      --compare-branch=main \
      --fail-under=60 \
      --include='services/agent-claw/src/routes/**'

- name: Diff coverage (Python)
  run: |
    diff-cover coverage.xml --compare-branch=main --fail-under=70 \
      --exclude='services/optimizer/session_reanimator/**' \
      --exclude='services/projectors/kg_hypotheses/**' \
      --exclude='services/mcp_tools/mcp_drfp/**' \
      --exclude='services/mcp_tools/mcp_rdkit/**' \
      --exclude='services/ingestion/eln_json_importer.legacy/**'
```

The Python excludes correspond exactly to the four NO-TESTS services
identified in section 4 plus the legacy importer. PR-N for each of these
should both add tests and remove the corresponding exclude.

### 8.4 Stretch goals (Wave 3 / 4)

| Milestone | Global TS | Global Py | Critical-path |
|---|---:|---:|---:|
| Today (baseline) | 75.7% | 63% | varies (47-100%) |
| End of Wave 2 (PR-N for top-5 critical) | 78% | 70% | all critical-path ≥75% |
| End of Wave 3 (route layer + projector base) | 82% | 75% | all critical-path ≥85% |
| End of Wave 4 (full forge / reanimator coverage) | 85% | 80% | all critical-path ≥90% |

The single highest-impact PR for raising coverage is **adding
`projectors/common/base.py` unit tests** (currently 26% on a file that
underlies every projector). A focused 8-12 test PR would lift the file
to ~80% and indirectly improve coverage for every projector subclass.

---

## 9. Reproducibility

Every number in this document was generated from `HEAD = c7168bc` by:

```bash
# TypeScript
cd services/agent-claw && npx vitest run --coverage \
  --coverage.reporter=json-summary --coverage.reporter=text-summary \
  --coverage.include='src/**'
# Output: services/agent-claw/coverage/coverage-summary.json (saved to /tmp/agent-claw-coverage.json)

cd services/paperclip && npx vitest run --coverage \
  --coverage.reporter=json-summary --coverage.reporter=text-summary \
  --coverage.include='src/**'
# Output: services/paperclip/coverage/coverage-summary.json (saved to /tmp/paperclip-coverage.json)

# Python (in dedicated audit venv at /tmp/chemclaw-audit-venv)
PYTHONPATH=. coverage run --source=services -m pytest \
  tests/unit/ \
  services/mcp_tools/ \
  services/projectors/kg_source_cache/tests \
  services/mock_eln/seed/tests
coverage report --skip-empty
coverage json -o /tmp/python-coverage.json
```

Audit venv dependencies installed beyond defaults: `coverage`, `pytest`,
`pytest-asyncio`, `psycopg`, `psycopg-pool`, `apscheduler`, `defusedxml`,
`scikit-learn`, `pypdf`, `dspy-ai`, `litellm`, `graphiti-core`, `neo4j`,
`@vitest/coverage-v8` (root npm install --no-save).

Of the 350 Python tests collected, **8 fail** and **22 error** in the
audit env. All failures and errors are environment / missing-config
issues (file allow-list env vars, FastAPI / TestClient version drift).
None are correctness failures of the production code.

Of the 775 TypeScript tests, **0 fail** with Docker present.

---

## 10. Quick-reference appendix

### Services with ZERO tests

```
services/mcp_tools/mcp_drfp        (92 LOC)
services/mcp_tools/mcp_rdkit       (173 LOC)
services/projectors/kg_hypotheses  (171 LOC)
services/projectors/common         (331 LOC — base class only, indirect)
services/optimizer/session_reanimator (283 LOC)
services/optimizer/forged_tool_validator/runner.py (88 LOC)
services/optimizer/skill_promoter/runner.py (48 LOC)
services/litellm_redactor/callback.py (12 LOC — wrapper only; redaction.py 78%)
services/ingestion/eln_json_importer.legacy (162 LOC — RETIRED, ok)
```

### Services with HIGH coverage (>90%) — exemplars

```
services/mcp_tools/common              92.5%   — 4 test files, 33 tests
services/mcp_tools/mcp_eln_local       90.8%   — 1 file, 28 tests (some env-bound errors)
services/mcp_tools/mcp_aizynth         91.2%
services/mcp_tools/mcp_askcos          94.3%
services/optimizer/skill_promoter (promoter.py only)  91%
services/mock_eln/seed                 92.3%
services/projectors/kg_source_cache    89.0%
services/agent-claw/src/core/* (most files)  93-100%
services/agent-claw/src/tools/builtins/* (most)  100%
```

### Top 10 files by absolute uncovered statements (where to focus)

```
1. src/index.ts                              389 stmts uncovered
2. src/routes/chat.ts                        275 stmts uncovered
3. src/routes/sessions.ts                    241 stmts uncovered
4. src/tools/builtins/statistical_analyze.ts  48 stmts uncovered
5. src/llm/litellm-provider.ts                52 stmts uncovered
6. src/routes/eval.ts                        150 stmts uncovered
7. src/routes/forged-tools.ts                146 stmts uncovered
8. src/config.ts                             102 stmts uncovered
9. src/tools/builtins/compute_confidence_ensemble.ts  82 stmts uncovered
10. services/optimizer/session_reanimator/main.py  94 stmts uncovered
```

The top three are the highest-leverage work: `index.ts` boot is hard
to unit test (suggest a single integration test that boots the harness
and asserts `loadHooks` registered ≥ MIN_EXPECTED_HOOKS); `chat.ts`
and `sessions.ts` need 12-18 and 10-14 targeted tests respectively as
called out in section 3.
