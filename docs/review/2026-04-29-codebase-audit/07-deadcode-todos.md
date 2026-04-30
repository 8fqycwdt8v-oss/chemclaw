# Track G — Dead Code & TODO Findings

Audit date: 2026-04-29
Scope: `chemclaw` repository @ `main` (read-only on code; output to
`docs/review/2026-04-29-codebase-audit/`).
Working directory: `/Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-audit`.

This file enumerates safe-to-act-on findings. Anything labelled "false positive"
should NOT be deleted. Confirmed orphans are ranked by deletion safety.

---

## 1. ts-prune sweep

### 1.1 agent-claw

Command: `cd services/agent-claw && npx ts-prune --error 2>&1`
Tool: ts-prune@0.10.3 (auto-installed; not pinned in repo).
Total entries: **305**. Of those, **103** lack the `(used in module)`
suffix (i.e., the export is reachable from no other module that ts-prune
sees). The rest are private-to-module declarations and harmless.

ts-prune's known blind spots in this repo:

- It does NOT trace `tests/**/*.ts` imports.
- It does NOT understand the dynamic `registry.registerBuiltin(...)`
  pattern at `services/agent-claw/src/index.ts:185-258`, which is the
  primary tool-registration mechanism.
- It treats every type-only re-export as orphan unless an explicit
  type import resolves through it.

About 90% of the 103 are false positives once those paths are
accounted for. The triage below cites every entry by file:line.

#### Raw ts-prune output — first 40 entries (verbatim)

```
src/index.ts:455 - pool (used in module)
src/index.ts:455 - registry (used in module)
src/index.ts:455 - llmProvider (used in module)
src/index.ts:455 - promptRegistry (used in module)
src/index.ts:455 - lifecycle (used in module)
src/index.ts:455 - skillLoader (used in module)
src/index.ts:455 - probeMcpTools (used in module)
src/core/budget.ts:10 - SessionBudgetSnapshot (used in module)
src/core/budget.ts:19 - BudgetOptions (used in module)
src/core/compactor.ts:61 - estimateTokens (used in module)
src/core/compactor.ts:72 - shouldCompact
src/core/compactor.ts:22 - SynopsisResult (used in module)
src/core/compactor.ts:31 - CompactorOptions (used in module)
src/core/confidence.ts:79 - crossModelAgreement
src/core/confidence.ts:118 - extractFactIds
src/core/confidence.ts:164 - jaccardSimilarity
src/core/confidence.ts:23 - BayesianPosterior (used in module)
src/core/confidence.ts:110 - CrossModelLlmProvider (used in module)
src/core/harness.ts:29 - HarnessOptions (used in module)
src/core/harness.ts:29 - HarnessResult (used in module)
src/core/harness.ts:237 - AgentDeps (used in module)
src/core/harness.ts:246 - AgentCallOptions (used in module)
src/core/hook-loader.ts:83 - HookDeps (used in module)
src/core/hook-loader.ts:130 - HookLoadResult (used in module)
src/core/hook-output.ts:15 - PreToolUseSpecificOutput (used in module)
src/core/hook-output.ts:22 - PostToolUseSpecificOutput (used in module)
src/core/hook-output.ts:27 - HookSpecificOutput (used in module)
src/core/lifecycle.ts:38 - DispatchOptions (used in module)
src/core/lifecycle.ts:50 - DispatchResult (used in module)
src/core/paperclip-client.ts:33 - PaperclipClientOptions (used in module)
src/core/plan-mode.ts:33 - Plan (used in module)
src/core/plan-mode.ts:99 - PlanStepEvent
src/core/plan-mode.ts:107 - PlanReadyEvent
src/core/plan-store-db.ts:16 - PlanStatus (used in module)
src/core/plan-store-db.ts:24 - DbPlan (used in module)
src/core/request-context.ts:19 - RequestContext (used in module)
src/core/sandbox.ts:132 - buildSandboxClient
src/core/sandbox.ts:16 - SandboxHandle (used in module)
src/core/sandbox.ts:23 - ExecutionResult (used in module)
src/core/sandbox.ts:36 - SandboxError (used in module)
```

(Saved in full at `/tmp/tsprune_agentclaw.txt` during the audit run;
305 total lines.)

#### Confirmed orphans (truly unused — safe to delete)

| File:line | Symbol | Reason | Action |
|---|---|---|---|
| `services/agent-claw/src/routes/forged-tools.ts:67` | `registerForgedToolsRoutes` | Route file is fully implemented (260 LOC, GET/POST/disable/scope) but `services/agent-claw/src/index.ts` never imports or calls it. The matching test file `tests/unit/routes/forged-tools-route.test.ts:1` exercises it directly without going through the app. | **Action**: either wire `registerForgedToolsRoutes(app, pool, getUser)` into `index.ts` near other route registrations (`index.ts:264-357`) or delete the file + its test. The first option is what the file's docstring and tests suggest is intended. Real finding. |
| `services/agent-claw/src/core/skills.ts:362` (`getSkillLoader`) | factory accessor | The single import of `SkillLoader` in `index.ts` constructs it via `new SkillLoader(...)` — the singleton accessor is never reached. | Delete `getSkillLoader` and `_resetSkillLoader` together; they were leftover from an earlier per-process-singleton pattern. |
| `services/agent-claw/src/core/skills.ts:371` (`_resetSkillLoader`) | test-only reset | No test imports it. | Delete with the above. |
| `services/agent-claw/src/prompts/shadow-evaluator.ts:34` (`ShadowScoreResult`) | exported interface | Only mentioned in its own definition file. Caller types via `Promise<unknown>` shape. | Either delete or have `services/agent-claw/src/routes/optimizer.ts` import the type; currently it inlines a structurally equivalent shape. |
| `services/agent-claw/src/tools/_limits.ts:23` (`MAX_BATCH_RXN_SMILES`) | constant | Defined in 2026-02 to mirror `services/mcp_tools/common/limits.py`. No TS site enforces a batch limit on rxn-smiles arrays today. | Keep — file's own docstring (line 1-11) explicitly says these are intentional mirror constants. Mark as **false positive**. |
| `services/agent-claw/src/tools/_limits.ts:26` (`MAX_INCHIKEY_LEN`) | constant | Same as above. | Keep — false positive. |
| `services/agent-claw/src/tools/tool.ts:65` (`ToolSchema`) | re-exported interface | Defined but consumers use `Tool["schema"]` indexed access. | Keep — public API surface for forged tools. **False positive.** |
| `services/agent-claw/src/mcp/postJson.ts:102` (`getJson`) | HTTP helper | The whole codebase uses `postJson` (MCP convention is POST for /tools/* endpoints). `getJson` exists for symmetry / future GET endpoints. | Keep — public API. **False positive.** |
| `services/agent-claw/src/observability/otel.ts:109` (`getProvider`) | provider accessor | Only the same file's `init()` uses the underlying provider. | Either delete or expose for ops debugging. Low value either way. |
| `services/agent-claw/src/observability/spans.ts:90` (`startToolSpan`) | span helper | The harness uses `tracer.startActiveSpan(...)` directly (`harness.ts:120`-ish). | Helper was written ahead of the call sites being migrated. **Real orphan** — delete or migrate the call sites. |
| `services/agent-claw/src/observability/spans.ts:105` (`startSubAgentSpan`) | span helper | Same as above. | Same — delete or migrate. |
| `services/agent-claw/src/security/mcp-token-cache.ts:125` (`clearMcpTokenCache`) | test reset | Used by 2 tests (`mcp-token-cache.test.ts` and `mcp-tokens.test.ts`). | **False positive** — ts-prune missed the test imports. |
| `services/agent-claw/src/security/workspace-boundary.ts:48` (`assertWithinWorkspace`) | path check | 14 hits across the codebase including 6 tool builtins (`run_program.ts`, `forge_tool.ts`, etc.) and tests. | **False positive.** |
| `services/agent-claw/src/core/plan-mode.ts:99` (`PlanStepEvent`) | event-shape type | Type is referenced once in its own SSE event union. | Could be inlined; minor cleanup. |
| `services/agent-claw/src/core/plan-mode.ts:107` (`PlanReadyEvent`) | event-shape type | Same as above. | Same — minor. |
| `services/agent-claw/src/core/sandbox.ts:51` (`SANDBOX_MAX_MEM_MB`) | env-resolved limit | Only the matching CPU constant is imported. | The file declares 3 constants and exports 2; only `SANDBOX_MAX_CPU_S` is read elsewhere (`run_program.ts`). Either wire MEM into sandbox creation or delete. **Real finding** — likely a bug (memory cap silently ignored). |
| `services/agent-claw/src/core/sandbox.ts:132` (`buildSandboxClient`) | factory | Used by 5 unit tests + `run_program.ts`. | **False positive** — ts-prune misses test imports. |
| `services/agent-claw/src/core/compactor.ts:72` (`shouldCompact`) | budget check | Defined on `Budget` (`budget.ts:135`) and called from `harness.ts:126`. | **False positive** — wrong file. The compactor itself doesn't export `shouldCompact`; ts-prune is reporting a re-export that's already private. |
| `services/agent-claw/src/core/confidence.ts:79` (`crossModelAgreement`) | scorer helper | Used by `compute_confidence_ensemble.ts` and 9 tests. | **False positive.** |
| `services/agent-claw/src/core/confidence.ts:118` (`extractFactIds`) | helper | Used by `anti-fabrication.ts:43` (re-export), `synthesize_insights.ts`, and tests. | **False positive.** |
| `services/agent-claw/src/core/confidence.ts:164` (`jaccardSimilarity`) | helper | Used by `crossModelAgreement` (same file) and 6 tests. | **False positive.** |
| `services/agent-claw/src/core/slash.ts:126` (`parseForgedArgs`) | parser | Used by `core/step.ts` slash dispatch and 8 tests. | **False positive.** |
| `services/agent-claw/src/llm/provider.ts:73` (`StubLlmProvider`) | test fixture | Used by ≥30 tests. | **False positive.** |
| `services/agent-claw/src/core/sub-agent.ts:66` (`Citation`) | typed result shape | 30 hits — primarily tests. | **False positive.** |
| `services/agent-claw/src/core/hooks/source-cache.ts:380` (`checkStaleFacts`) | helper | Called by 6 tests directly + the hook itself. | **False positive.** |
| `services/agent-claw/src/routes/eval-parser.ts:5` (`EvalSubCommand`) | type re-export | The file is itself a re-export shim (`eval-parser.ts:1-6` documents the circular-import workaround). Imported by `routes/eval.ts`. | **False positive.** |
| `services/agent-claw/src/routes/chat.ts:87` (`StreamEvent`) | SSE event union | Used by `streaming/sse.ts` and 2 tests. | **False positive.** |
| `services/agent-claw/src/tools/builtins/*.ts` — 67 `Input`/`Output` Zod-derived types and 6 `build*Tool` factories | type aliases / factories | All 67 `Input`/`Output` aliases are intentionally exported as the public schema surface for LLM tool registration; the 6 `build*Tool` factories (`buildAddForgedToolTestTool`, `buildDispatchSubAgentTool`, `buildInduceForgedToolFromTraceTool`, `buildMarkResearchDoneTool`, `buildSandboxClient`, `buildRunProgramTool`) are all imported from `tests/unit/...` and `tests/integration/...`. | **False positive (en masse).** ts-prune ignores the test tree. The 5 of these tools intentionally NOT registered in `index.ts` are documented at `index.ts:246-250` ("forge_tool, run_program, induce_forged_tool_from_trace, dispatch_sub_agent, add_forged_tool_test are intentionally NOT registered here"). |
| `services/agent-claw/src/tools/builtins/search_knowledge.ts:171` (`_rrfForTests`) | export | Only tests use it. | **False positive.** |
| `services/agent-claw/src/tools/builtins/run_program.ts:342` (`clearStubCache`) | test helper | Used by 3 tests. | **False positive.** |

**Summary — agent-claw**: 1 truly orphaned route file
(`forged-tools.ts`), 4 minor orphan helpers (`getSkillLoader`,
`_resetSkillLoader`, `startToolSpan`, `startSubAgentSpan`,
`SANDBOX_MAX_MEM_MB`), and 1 unused interface (`ShadowScoreResult`).
The other ~95 ts-prune entries are false positives caused by ts-prune
not crawling tests.

### 1.2 paperclip

Command: `cd services/paperclip && npx ts-prune --error 2>&1`
Total entries: **10** — all `(used in module)`.

Raw output (verbatim — all 10 lines):

```
src/budget.ts:13 - BudgetConfig (used in module)
src/budget.ts:28 - Reservation (used in module)
src/budget.ts:37 - BudgetCheckResult (used in module)
src/concurrency.ts:10 - ConcurrencyEntry (used in module)
src/heartbeat.ts:13 - HeartbeatEntry (used in module)
src/index.ts:88 - buildApp (used in module)
src/index.ts:302 - budgetMgr (used in module)
src/index.ts:302 - heartbeat (used in module)
src/index.ts:302 - metrics (used in module)
src/metrics.ts:6 - MetricCounters (used in module)
```

| File:line | Symbol | Verdict |
|---|---|---|
| `services/paperclip/src/budget.ts:13` | `BudgetConfig` | **False positive** — `(used in module)`. |
| `services/paperclip/src/budget.ts:28` | `Reservation` | **False positive** — internal type. |
| `services/paperclip/src/budget.ts:37` | `BudgetCheckResult` | **False positive** — internal type. |
| `services/paperclip/src/concurrency.ts:10` | `ConcurrencyEntry` | **False positive.** |
| `services/paperclip/src/heartbeat.ts:13` | `HeartbeatEntry` | **False positive.** |
| `services/paperclip/src/index.ts:88` | `buildApp` | **False positive** — exported for tests; (used in module) tag means same-file reference. |
| `services/paperclip/src/index.ts:302` | `budgetMgr` / `heartbeat` / `metrics` | startup-time singletons. **False positive.** |
| `services/paperclip/src/metrics.ts:6` | `MetricCounters` | **False positive.** |

**Summary — paperclip**: zero real orphans.

---

## 2. Vulture sweep

Command: `vulture services/ --min-confidence 80 2>&1` (vulture@2.16
installed via pip during this audit — not pinned in `pyproject.toml`).
Total entries: **13**.

Raw output (verbatim — all 13 lines):

```
services/litellm_redactor/callback.py:20: unused variable 'completion_response' (100% confidence)
services/litellm_redactor/callback.py:21: unused variable 'start_time' (100% confidence)
services/litellm_redactor/callback.py:22: unused variable 'end_time' (100% confidence)
services/mcp_tools/common/tests/test_scope_enforcement.py:75: unused variable 'enforced_env' (100% confidence)
services/mcp_tools/common/tests/test_scope_enforcement.py:82: unused variable 'enforced_env' (100% confidence)
services/mcp_tools/common/tests/test_scope_enforcement.py:91: unused variable 'enforced_env' (100% confidence)
services/mcp_tools/common/tests/test_scope_enforcement.py:108: unused variable 'enforced_env' (100% confidence)
services/mcp_tools/common/tests/test_scope_enforcement.py:117: unused variable 'enforced_env' (100% confidence)
services/mcp_tools/common/tests/test_scope_enforcement.py:132: unused variable 'enforced_env' (100% confidence)
services/mcp_tools/common/tests/test_scope_enforcement.py:148: unused variable 'enforced_env' (100% confidence)
services/mcp_tools/mcp_doc_fetcher/main.py:491: unused import 'PIL' (90% confidence)
services/optimizer/forged_tool_validator/validator.py:29: unused import 'given' (90% confidence)
services/optimizer/forged_tool_validator/validator.py:29: unused import 'HealthCheck' (90% confidence)
```

Vulture's known blind spots in this repo:

- It misses Pydantic field declarations (treated as unused class attrs).
  Confirmed by manual scan: no Pydantic model fields appear in
  vulture's output, but that's because everything is annotated and
  vulture's heuristic excludes them at the 80% threshold. Lower
  thresholds would generate noise.
- It misses FastAPI dependency-injection signatures (`Depends(...)`).
- It misses callback-protocol signatures with required positional args
  (the LiteLLM `pre_api_call` case in `callback.py:20-22`).
- It misses pytest context-manager bindings (`with monkeypatch.context()
  as enforced_env:`).
- It misses conditional imports inside `try/except ImportError` blocks.

All 13 entries below fall into one of those blind spots.

Triage:

| File:line | Symbol | Vulture verdict | Reality |
|---|---|---|---|
| `services/litellm_redactor/callback.py:20` | `completion_response` | unused variable (100%) | **False positive** — required positional arg in LiteLLM's `pre_api_call` callback signature. Already annotated `# noqa: ARG001` on line 20 (vulture doesn't honour ARG001). Keep. |
| `services/litellm_redactor/callback.py:21` | `start_time` | unused variable (100%) | **False positive** — same callback signature. Keep. |
| `services/litellm_redactor/callback.py:22` | `end_time` | unused variable (100%) | **False positive** — same callback signature. Keep. |
| `services/mcp_tools/common/tests/test_scope_enforcement.py:75` | `enforced_env` | unused variable (100%) | **False positive** — context-manager binding for `pytest.MonkeyPatch.context()`. The fixture wires env vars for the test body; vulture doesn't see that. Keep. |
| `services/mcp_tools/common/tests/test_scope_enforcement.py:82` | `enforced_env` | unused | Same as above. **False positive.** |
| `services/mcp_tools/common/tests/test_scope_enforcement.py:91` | `enforced_env` | unused | Same. **False positive.** |
| `services/mcp_tools/common/tests/test_scope_enforcement.py:108` | `enforced_env` | unused | Same. **False positive.** |
| `services/mcp_tools/common/tests/test_scope_enforcement.py:117` | `enforced_env` | unused | Same. **False positive.** |
| `services/mcp_tools/common/tests/test_scope_enforcement.py:132` | `enforced_env` | unused | Same. **False positive.** |
| `services/mcp_tools/common/tests/test_scope_enforcement.py:148` | `enforced_env` | unused | Same. **False positive.** |
| `services/mcp_tools/mcp_doc_fetcher/main.py:491` | `import PIL` | unused import (90%) | **Conditional import** inside a `try:` block (line 488-498). Used implicitly by `pdf2image.convert_from_bytes` for PIL.Image return type. Vulture misses the runtime dependency. Keep, but add `# noqa: F401` to silence in the future. |
| `services/optimizer/forged_tool_validator/validator.py:29` | `import given` | unused import (90%) | **Conditional import** inside `try:` (lines 28-34) for an optional Hypothesis dependency. The module re-exports `given`, `settings`, `HealthCheck`, and `st`; only `settings` and `st` are used by name in this file but `given` is exposed via `_HAS_HYPOTHESIS` flag for downstream test modules. Keep. |
| `services/optimizer/forged_tool_validator/validator.py:29` | `import HealthCheck` | unused import (90%) | Same as above — re-exported for downstream tests. Keep. |

**Summary — vulture**: 13/13 false positives. Zero actionable findings.
None of vulture's flags apply to actual application code.

---

## 3. TODO / FIXME / HACK / XXX classification

Command: `git grep -nE 'TODO|FIXME|HACK|XXX' -- '*.ts' '*.py' '*.sql' '*.yaml' '*.md'`.
Total raw matches: **18**.

Raw grep output (verbatim — 18 lines):

```
docs/adr/009-permission-and-decision-contract.md:62:   - `ask` and `defer` are treated as `allow` with a TODO log line in
docs/adr/009-permission-and-decision-contract.md:90:work or make the contract awkward to roll out incrementally. The TODO
docs/adr/010-deferred-phases.md:146:TODO and ADR 008's "future work" section.
docs/plans/production-readiness-round.md:68:- Code comments quality: spot-check for over-commenting / out-of-date comments / TODOs left from the autonomy work
docs/security-notes.md:45:## What's still TODO (tracked in the plan)
documentation/compass_artifact_wf-...md:340:│ ACTIVE SCRATCHPAD / WORKING MEMORY (~8-16K, writeable) │ ← plan, hypotheses, TODOs
services/agent-claw/src/core/lifecycle.ts:255:        // TODO(observability): replace with a centralised pino logger when
services/agent-claw/src/core/step.ts:160:  // TODO(phase-6-permissions): wire ask/defer to a route-level prompt.
services/agent-claw/src/core/types.ts:257:// TODO(phase-6-permissions): no dispatch site yet. Phase 6's permission
services/agent-claw/src/routes/chat.ts:632:  // TODO(disconnect-mid-stream): runHarness doesn't accept an AbortSignal,
services/agent-claw/src/routes/deep-research.ts:200:  // TODO(disconnect-mid-stream): runHarness doesn't accept an AbortSignal,
services/agent-claw/tests/unit/mcp-token-cache.test.ts:18:const KEY = "test-signing-key-32-bytes-XXXXXX";
services/agent-claw/tests/unit/mcp-tokens.test.ts:10:const KEY = "test-signing-key-32-bytes-XXXXXX";
services/mcp_tools/common/tests/test_auth.py:15:KEY = "test-signing-key-32-bytes-XXXXXX"
services/mcp_tools/common/tests/test_scope_enforcement.py:23:KEY = "test-signing-key-32-bytes-XXXXXX"
services/optimizer/session_reanimator/main.py:24:  (dev) or X-Internal-Service-Token (production — TODO: ADR 006 Layer 2
tests/unit/mcp_kg/test_models.py:27:def _entity(label: str = "Compound", prop: str = "inchikey", val: str = "XXX") -> EntityRef:
tests/unit/mcp_kg/test_models.py:48:        assert e.id_value == "XXX"
```

Note: zero `FIXME` and zero `HACK` markers exist anywhere in the
matched filetypes — only `TODO` and the `XXX` substring (the latter
is mostly fixture padding).

| File:line | Marker | Class | Verdict / Action |
|---|---|---|---|
| `docs/adr/009-permission-and-decision-contract.md:62` | TODO (in prose) | documentation | The string "TODO log line" is part of an ADR sentence, not an action. **Not a TODO.** Ignore. |
| `docs/adr/009-permission-and-decision-contract.md:90` | TODO (in prose) | documentation | Same — "the TODO" refers to a previous bullet. **Not a TODO.** Ignore. |
| `docs/adr/010-deferred-phases.md:146` | TODO | aspirational | Refers to ADR 008's future-work backlog; ADR 010 is itself the deferred-phases register. **Aspirational** — already tracked. No action. |
| `docs/plans/production-readiness-round.md:68` | TODO | aspirational | Plan-doc bullet "spot-check for ... TODOs left from the autonomy work" — that's literally this audit. **Track G output is the answer.** No action. |
| `docs/security-notes.md:45` | TODO heading | documentation | Section header "What's still TODO (tracked in the plan)". Real document, not a code TODO. Keep. |
| `documentation/compass_artifact_wf-...md:340` | TODO (in third-party doc) | documentation | Inside a verbatim diagram inside a vendored whitepaper. **Not actionable.** Ignore. |
| `services/agent-claw/src/core/lifecycle.ts:255` | TODO(observability) | real | "replace with a centralised pino logger when …" — file currently uses raw `console.error`. **Real**. Action: in a follow-up, swap to the pino logger that's already wired in `index.ts:170-ish`. Low priority. |
| `services/agent-claw/src/core/step.ts:160` | TODO(phase-6-permissions) | aspirational | "wire ask/defer to a route-level prompt" — ADR 009 explicitly states `ask` and `defer` collapse to `allow` until phase 6. **Aspirational** — covered by ADR 009 and ADR 010 ("deferred phases"). No action this audit. |
| `services/agent-claw/src/core/types.ts:257` | TODO(phase-6-permissions) | aspirational | "no dispatch site yet. Phase 6's permission …" — same phase-6 deferral as above. Tracked in ADR 010. No action. |
| `services/agent-claw/src/routes/chat.ts:632` | TODO(disconnect-mid-stream) | real | "runHarness doesn't accept an AbortSignal …" — when a client disconnects mid-stream the harness keeps running until it naturally finishes. **Real bug** (token waste, leaked compute). Action: thread AbortSignal through `runHarness` → tool dispatch. Medium priority. |
| `services/agent-claw/src/routes/deep-research.ts:200` | TODO(disconnect-mid-stream) | real | Identical issue, identical fix. Pair with the chat-route TODO. |
| `services/agent-claw/tests/unit/mcp-token-cache.test.ts:18` | XXXXXX | documentation | Test fixture key suffix `"test-signing-key-32-bytes-XXXXXX"` — six X's are intentional padding to hit the 32-byte minimum. **Not a HACK marker.** Ignore. |
| `services/agent-claw/tests/unit/mcp-tokens.test.ts:10` | XXXXXX | documentation | Same — fixture padding. Ignore. |
| `services/mcp_tools/common/tests/test_auth.py:15` | XXXXXX | documentation | Same — fixture padding. Ignore. |
| `services/mcp_tools/common/tests/test_scope_enforcement.py:23` | XXXXXX | documentation | Same — fixture padding. Ignore. |
| `services/optimizer/session_reanimator/main.py:24` | TODO: ADR 006 Layer 2 | aspirational | "X-Internal-Service-Token (production — TODO: ADR 006 Layer 2 mints a real JWT)" — ADR 006 already mostly landed (Layer 2 partial). The reanimator now mints a JWT (per CLAUDE.md "MCP service Bearer-token authentication" section). **Stale comment** — the actual code already uses the JWT path (`session_reanimator/main.py` mints `agent:resume`). Remove the comment. |
| `tests/unit/mcp_kg/test_models.py:27` | "XXX" | documentation | Test data — `EntityRef(id_value="XXX")`. Not a HACK. Ignore. |
| `tests/unit/mcp_kg/test_models.py:48` | "XXX" | documentation | Test assertion. Ignore. |

**Real, actionable TODOs (3):**
1. `lifecycle.ts:255` — switch to centralised pino logger.
2. `chat.ts:632` + `deep-research.ts:200` — thread AbortSignal through
   runHarness so client disconnects stop in-flight work.

**Stale comment (1):** `session_reanimator/main.py:24` — the JWT path is
already implemented; the TODO is no longer accurate. Update the comment.

**Aspirational (3):** the two phase-6-permissions TODOs in `step.ts:160`
and `types.ts:257`, plus the ADR 010 reference in
`docs/adr/010-deferred-phases.md:146`. All tracked in ADR 010.
No action.

---

## 4. Unreferenced files

### 4.1 TypeScript files in `services/agent-claw/src/`

Method: for every `.ts` file (excluding `index.ts`), search the entire
agent-claw source + test trees for `from '<path>/<basename>(.js)?'`
imports.

| File | Status |
|---|---|
| `services/agent-claw/src/routes/forged-tools.ts` (260 LOC) | **Unreferenced from index.ts** (see § 1.1). Tests at `tests/unit/routes/forged-tools-route.test.ts` exercise it directly. **Real finding** — wire or delete. |

All other 106 TS files are imported somewhere. No other orphans.

### 4.2 Python files in `services/`

Method: search `import|from` for each module's basename across `services/` and `tests/`.

| File | Status |
|---|---|
| `services/optimizer/scripts/seed_golden_set.py` (142 LOC) | **Stand-alone CLI script** — invoked manually per `AGENTS.md:670` (`python services/optimizer/scripts/seed_golden_set.py …`). Not imported. **Intended public API** — keep. |

All `.legacy/` files in `services/ingestion/eln_json_importer.legacy/`
are intentionally retired (per `services/ingestion/eln_json_importer.legacy/README.md`)
and called out in CLAUDE.md as the bulk-migration escape hatch. Keep.

### 4.3 YAML hooks (`hooks/*.yaml`) vs. `BUILTIN_REGISTRARS`

11 YAML files in `hooks/`. Each was checked against the
`BUILTIN_REGISTRARS` map at `services/agent-claw/src/core/hook-loader.ts:94-124`.

Result: **all 11 hooks have matching registrars**:

```
OK: anti-fabrication
OK: apply-skills
OK: budget-guard
OK: compact-window
OK: foundation-citation-guard
OK: init-scratch
OK: permission
OK: redact-secrets
OK: session-events
OK: source-cache
OK: tag-maturity
```

No orphaned YAMLs, no orphan registrar entries.

### 4.4 SQL files in `db/init/` not auto-applied

The Postgres image mounts the entire directory via
`docker-compose.yml:27` (`./db/init:/docker-entrypoint-initdb.d:ro`),
which auto-applies every `.sql` file in lexical order at first boot.
Therefore every file in `db/init/` is applied. Confirmed by listing —
20 files (`01_schema.sql` through `16_db_audit_fixes.sql`,
plus `30_mock_eln_schema.sql` and `31_fake_logs_schema.sql`).

The `Makefile:db.init` target re-applies only `01_schema.sql`
(`Makefile:87`); the other 19 require either a fresh volume or a
manual `docker compose exec ... psql ... < db/init/NN_*.sql`. That's a
separate developer-experience finding handled in Track A or D, not a
dead-file finding here.

---

## 5. Dead SQL columns

For every `ADD COLUMN` in `db/init/02-16`, I searched for at least one
INSERT or UPDATE/SET that writes the column.

| Column | File:line where added | Writes? | Finding |
|---|---|---|---|
| `documents.original_uri` | `04_doc_origin.sql:18` | YES — `services/ingestion/doc_ingester/importer.py` writes documents (separate column path); read by `analyze_csv.ts:253` and `documents.ts:53`. | OK. |
| `document_chunks.contextual_prefix` | `05_contextual_chunks.sql:8` | YES — `services/projectors/contextual_chunker/main.py` UPDATE. | OK. |
| `document_chunks.page_number` | `05_contextual_chunks.sql:9` | YES — same projector, line 165. | OK. |
| `document_chunks.byte_start` | `12_security_hardening.sql:40` | **NO** — only QUERIED by `services/projectors/contextual_chunker/main.py:106-177`, never inserted. The `INSERT INTO document_chunks` in `services/ingestion/doc_ingester/importer.py:120` lists only `(document_id, chunk_index, heading_path, text, token_count)`. | **Real dead-write finding.** The contextual_chunker has a `if is_pdf and row.get("byte_start") is not None` branch that will *always* be false until the doc_ingester populates `byte_start`. Either: (a) update the doc_ingester to capture byte offsets during chunking and INSERT them, or (b) drop the columns and the dependent code path. Option (a) is what `12_security_hardening.sql:27` ("contextual_chunker projector queries `byte_start` / `byte_end`") implies was intended. **Medium priority** — silently degrades PDF page-number accuracy for ingested documents to a 2000-byte heuristic at line 174-177. |
| `document_chunks.byte_end` | `12_security_hardening.sql:41` | **NO** — never read or written outside the migration's COMMENT. | Same as above. The SQL even creates an index `idx_document_chunks_byte_start` (line 44-45) gated `WHERE byte_start IS NOT NULL` — the index is empty in production. |
| `artifacts.maturity` | `07_maturity_tiers.sql:10/14/18` | YES — `services/agent-claw/src/core/hooks/tag-maturity.ts:32`. | OK. |
| `artifacts.confidence_ensemble` | `07_maturity_tiers.sql:32` | YES — `services/agent-claw/src/tools/builtins/compute_confidence_ensemble.ts:126` UPDATE. | OK. |
| `skill_library.shadow_until` | `06_skill_library.sql:20` | YES — `services/agent-claw/src/tools/builtins/forge_tool.ts:411` (INSERT) and `services/optimizer/skill_promoter/promoter.py:402,421` (UPDATE). | OK. |
| `prompt_registry.shadow_until` | `11_optimizer.sql:11` | YES — `services/optimizer/gepa_runner/runner.py:151` (INSERT) and `skill_promoter/promoter.py` (UPDATE). | OK. |
| `prompt_registry.gepa_metadata` | `11_optimizer.sql:12` | YES — `services/optimizer/gepa_runner/runner.py:151,162`. | OK. |
| `feedback.prompt_name` | `15_feedback_prompt_link.sql:4` | YES — `services/agent-claw/src/routes/feedback.ts:52`. | OK. |
| `feedback.prompt_version` | `15_feedback_prompt_link.sql:5` | YES — same INSERT. | OK. |
| `skill_library.scope` | `10_forged_tool_scope.sql:12` | YES — `forge_tool.ts:411` (INSERT default 'private'); `routes/forged-tools.ts:209` (UPDATE on promotion). | OK. |
| `skill_library.forged_by_model` | `10_forged_tool_scope.sql:14` | YES — `forge_tool.ts:411`. | OK. |
| `skill_library.forged_by_role` | `10_forged_tool_scope.sql:15` | YES — same INSERT. | OK. |
| `skill_library.parent_tool_id` | `10_forged_tool_scope.sql:18` | YES — same INSERT. | OK. |
| `skill_library.scope_promoted_at` | `10_forged_tool_scope.sql:19` | YES — `routes/forged-tools.ts:209` (UPDATE). **Caveat**: `forged-tools.ts` is unwired in `index.ts` (§ 1.1), so the UPDATE never fires in production. Latent. |
| `skill_library.scope_promoted_by` | `10_forged_tool_scope.sql:20` | YES — same UPDATE, same caveat. |
| `skill_library.code_sha256` | `12_security_hardening.sql:363` | YES — `forge_tool.ts:410-411` (INSERT); read by `tools/registry.ts:303,401,441`. | OK. |
| `agent_sessions.etag` | `14_agent_session_extensions.sql:18` | DEFAULT auto-populates on INSERT (uuid_generate_v4); UPDATE in `session-store.ts` rotates it. Verified at `core/session-store.ts:236` (UPDATE … SET etag = $1). | OK. |
| `agent_sessions.session_input_tokens` | `14_agent_session_extensions.sql:57` | YES — `core/session-store.ts:274`. | OK. |
| `agent_sessions.session_output_tokens` | `14_agent_session_extensions.sql:58` | YES — same updateBudgetUsage path. | OK. |
| `agent_sessions.session_steps` | `14_agent_session_extensions.sql:59` | YES — same. | OK. |
| `agent_sessions.session_token_budget` | `14_agent_session_extensions.sql:60` | DEFAULT NULL; never explicitly written by application code. Read at `session-store.ts:202,93` and `session_reanimator/main.py:126`. | **Latent finding** — operators are expected to set this manually via SQL (per `AGENT_TOKEN_BUDGET` env var fallback in `config.ts:37`), but the column has no migration writing the env value down to the row. Result: the env-var default works, but the per-session override surface is unreachable from any code path. Either expose a route to set it, or drop the column. Low priority. |
| `agent_sessions.auto_resume_count` | `14_agent_session_extensions.sql:68` | YES — `session-store.ts:286,402` (UPDATE). | OK. |
| `agent_sessions.auto_resume_cap` | `14_agent_session_extensions.sql:69` | DEFAULT 10; never explicitly written by application code. Same situation as `session_token_budget` — the column exists but no INSERT or UPDATE in production code customizes it per session. Tests at `tests/integration/reanimator-roundtrip.test.ts:164,217` insert it directly via the test setup. | **Latent finding (same shape as above)** — there's no route or admin tool to bump the cap for a specific session. Either expose one or drop the per-row override. Low priority. |

**Summary — SQL**: two real findings (`byte_start` / `byte_end` never
written, dependent projector code path dead), two latent overrides
(`session_token_budget`, `auto_resume_cap`) with no caller, and one
caveat (the `scope_promoted_*` UPDATE only fires from a route that's
not wired into `index.ts`).

---

## 6. Legacy `services/agent/` references

CLAUDE.md states `services/agent/` was deleted in Phase F.

| Location | Reference | Status |
|---|---|---|
| `services/agent/` directory | confirmed: `ls services/agent` returns "No such file or directory" | OK — gone. |
| `services/agent-claw/src/index.ts:109` | `// Security plugins (parity with services/agent/src/index.ts).` | **Stale comment** — the parity reference is now historical. Remove or update to "(parity with the deleted legacy agent service)". Cosmetic. |
| `services/agent-claw/src/prompts/registry.ts:3` | `// Ported from services/agent/src/agent/prompts.ts.` | **Stale port-of comment** — informational, harmless. Keep or strip in a future cleanup. |
| `services/agent-claw/src/db/with-user-context.ts:1` | `// Row-Level Security helper — ported from services/agent/src/db.ts.` | **Stale port-of comment** — informational. Same as above. |
| `docs/superpowers/specs/2026-04-23-phase-5a-cross-learning-toolkit-design.md` (≥7 hits) | mentions `services/agent/src/...` | **Historical spec** — the spec was written before the rename. Keep as historical record. |
| `docs/superpowers/plans/2026-04-23-phase-5a-cross-learning-toolkit.md` (≥40 hits) | same — historical plan | Keep as historical record. |
| `CLAUDE.md:216` | "`services/agent/` deleted" | Correct documentation. Keep. |
| `docs/adr/004-harness-engineering.md:76` | "`services/agent/` deleted in" | Correct ADR text. Keep. |
| Compose / Makefile | no hits | OK. |
| Dockerfiles | no hits | OK. |
| Helm chart `infra/helm/` | no hits | OK. |

**Summary — legacy refs**: zero functional breakage; three
informational comments (`index.ts:109`, `registry.ts:3`,
`with-user-context.ts:1`) reference the deleted directory but are
just port-of attributions and not breakage.

---

## 7. Stale ADR references

Every ADR file referenced in `services/` code (`*.ts` / `*.py`):

| Reference | File:line | ADR file present? |
|---|---|---|
| ADR 001 (architecture) | `docs/adr/001-architecture.md` referenced in CLAUDE.md | YES |
| ADR 002 | none in code | n/a — file `002-*.md` does not exist; no broken refs |
| ADR 003 | none in code | n/a — file `003-*.md` does not exist; no broken refs |
| ADR 004 (harness engineering) | CLAUDE.md, `docs/PARITY.md:18,47`, `docs/adr/007-hook-system-rebuild.md:12` | YES — `docs/adr/004-harness-engineering.md` |
| ADR 005 (data layer) | CLAUDE.md | YES — `docs/adr/005-data-layer-revision.md` |
| ADR 006 (sandbox / MCP auth) | `services/optimizer/session_reanimator/main.py:24`, `services/optimizer/gepa_runner/runner.py:47`, `services/agent-claw/tests/unit/mcp-tokens.test.ts:1`, `services/agent-claw/src/security/mcp-tokens.ts:5`, `services/agent-claw/src/security/mcp-token-cache.ts:1`, `services/agent-claw/src/mcp/postJson.ts:9`, `services/mcp_tools/common/scopes.py:1`, `services/mcp_tools/common/auth.py:1,54`, `services/mcp_tools/common/app.py:52,57,138,217`, `services/mcp_tools/common/tests/test_scope_enforcement.py:3`, `services/mcp_tools/common/tests/test_auth.py:1` | YES — `docs/adr/006-sandbox-isolation.md` |
| ADR 007 (hook rebuild) | CLAUDE.md, `docs/PARITY.md:47` | YES — `docs/adr/007-hook-system-rebuild.md` |
| ADR 008 (collapsed ReAct loop) | `services/agent-claw/src/routes/chat.ts:769`, CLAUDE.md, `docs/PARITY.md` | YES — `docs/adr/008-collapsed-react-loop.md` |
| ADR 009 (permission/decision) | `services/agent-claw/src/core/permissions/resolver.ts:8`, CLAUDE.md, `docs/PARITY.md:20,49` | YES — `docs/adr/009-permission-and-decision-contract.md` |
| ADR 010 (deferred phases) | `services/agent-claw/src/core/permissions/resolver.ts:8`, `services/agent-claw/src/security/workspace-boundary.ts:9`, CLAUDE.md | YES — `docs/adr/010-deferred-phases.md` |

**Summary — ADR refs**: every ADR cited in code resolves to an existing
file. ADRs 002 and 003 do not exist on disk, but no reference in code
or docs targets them. The numbering gap is an artifact of
mid-development renumbering. Optional cleanup: add a short ADR-002
("vector layer choice") and ADR-003 ("LiteLLM egress chokepoint") so
the index reads contiguous, but no source citation is broken today.

---

## 8. Empty / one-liner / scaffolding files

Method: every `.ts` and `.py` under `services/` (excluding tests, dist,
node_modules, .venv, __pycache__) with `wc -l < f` returning < 30.
Hand-checked.

### TypeScript

| File | LOC | Verdict |
|---|---|---|
| `services/agent-claw/src/routes/eval-parser.ts` | 6 | Re-export shim documented (lines 1-4) as a deliberate circular-import workaround. **Keep.** |
| `services/agent-claw/src/routes/healthz.ts` | 10 | Liveness route. Trivially small but intentional. **Keep.** |
| `services/agent-claw/src/core/runtime.ts` | 22 | Singleton holder for the process-wide `Lifecycle`; documented (lines 1-11) as a circular-import break. **Keep.** |
| `services/agent-claw/src/tools/_limits.ts` | 26 | Mirror constants for chemistry payload bounds. Documented to mirror `services/mcp_tools/common/limits.py`. **Keep.** |
| `services/agent-claw/src/core/hooks/permission.ts` | 29 | No-op default permission hook (Phase 6 scaffold). Documented inline. **Keep — intentional.** |

### Python

| File | LOC | Verdict |
|---|---|---|
| `services/mcp_tools/common/settings.py` | 11 | Pydantic base class for MCP services. **Keep.** |
| `services/mcp_tools/mcp_kg/settings.py` | 14 | Subclass of the above. **Keep.** |
| `services/mcp_tools/mcp_embedder/settings.py` | 18 | Same. **Keep.** |
| `services/ingestion/eln_json_importer.legacy/settings.py` | 28 | Inside the documented legacy directory. **Keep — legacy preserved by design.** |
| `services/mcp_tools/mcp_embedder/models.py` | 29 | Pydantic types module. **Keep.** |

47 empty `__init__.py` files — namespace markers, all intentional. Not
dead code.

### Empty (zero or 1 LOC)

None found outside `__init__.py`.

**Summary — small files**: zero scaffolding leftovers. Every small
file has a documented reason for being small (re-export shim,
liveness probe, singleton holder, mirror-constant module, Phase-6
no-op hook, Pydantic settings).

---

## Aggregate findings (rank-ordered, for action)

### Definitely act on

1. **`services/agent-claw/src/routes/forged-tools.ts`** — fully
   implemented 260-LOC route file with passing tests at
   `tests/unit/routes/forged-tools-route.test.ts`, but
   `services/agent-claw/src/index.ts` never registers it. Either
   wire it in (matches the docstring intent and tests) or delete the
   file plus its tests. Latent: this also makes the
   `skill_library.scope_promoted_at` / `scope_promoted_by` UPDATE
   path unreachable in production.

2. **`document_chunks.byte_start` / `byte_end`** added in
   `db/init/12_security_hardening.sql:40-41`. Read by
   `services/projectors/contextual_chunker/main.py:106-177`, but
   `services/ingestion/doc_ingester/importer.py:120-128` never
   populates them. The PDF page-number-accuracy code path on
   `contextual_chunker.py:165-170` is dead in production. Fix the
   doc_ingester to capture byte offsets, or drop the columns + dead
   code path.

3. **`services/agent-claw/src/routes/chat.ts:632`** and
   **`services/agent-claw/src/routes/deep-research.ts:200`** —
   matching `TODO(disconnect-mid-stream)` comments. Threads the
   AbortSignal through `runHarness` so client disconnects stop
   in-flight tool calls and LLM streaming. Real correctness +
   cost-control issue.

### Light-touch cleanups

4. `services/agent-claw/src/observability/spans.ts:90,105` —
   `startToolSpan` / `startSubAgentSpan` exported but never used
   outside the same module. Either wire into the harness span
   instrumentation or delete.
5. `services/agent-claw/src/core/sandbox.ts:51` — `SANDBOX_MAX_MEM_MB`
   exported but never read. Likely a missed wiring (the matching CPU
   constant is enforced). Either pass into sandbox creation or delete.
6. `services/agent-claw/src/core/skills.ts:362,371` —
   `getSkillLoader` / `_resetSkillLoader` legacy from a singleton
   pattern that's no longer used. Delete.
7. `services/optimizer/session_reanimator/main.py:24` — TODO comment
   is stale; the JWT path is implemented. Update or remove the
   comment.
8. `services/agent-claw/src/core/lifecycle.ts:255` — switch from
   `console.error` to the centralised pino logger.

### No action (false positives or by-design)

- All 13 vulture findings.
- ~95 of 103 ts-prune entries (test imports + intentional public
  API surfaces).
- Phase-6-permissions TODOs (covered by ADR 010).
- `services/ingestion/eln_json_importer.legacy/` — kept by design.
- `services/agent/` "ported from" comments — historical
  attribution.
- ADR 002 / 003 numbering gap — no source citation broken.

---

End of Track G output.
