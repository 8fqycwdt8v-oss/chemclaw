# ChemClaw Codebase Audit — Wave 1 Summary

**Date:** 2026-04-29
**Branch:** `refactor/wave1-audit` (worktree at `../chemclaw-audit`)
**Tracks:** A (TS hotspots) · B (Python hotspots) · C (DB & schema) · D (Security & deps) · E (Coverage) · F (Boundaries) · G (Dead code & TODOs)

This is the consolidated, severity-ranked view. Each finding cites the source track's full report (in this directory) and routes to a Wave 2 PR. **PR-0 was added during audit** to absorb security P1s ahead of the original 8-PR plan.

---

## Headline takeaways

1. **Architecture is sound.** RLS (FORCE on every project-scoped table, three-role separation), MCP JWT fail-closed, LiteLLM single-egress chokepoint, redactor regex bounding, hooks 11/11 three-way parity, lifecycle singleton, `/api/internal/*` JWT-only trust, `MIN_EXPECTED_HOOKS` startup gate, projector idempotency — **all hold**.
2. **The redactor has a CPU-DoS regex.** `RXN_SMILES` (`\S{1,400}>\S{0,400}>\S{1,400}`) takes ~3.5s on 200KB adversarial input. Same defect in both Python (`redaction.py:42`) and TypeScript (`redact-secrets.ts:29`). Fix is one line each (gate on `>= 2` `>` chars).
3. **The doc-fetcher SSRF defence has an IPv4-mapped-IPv6 bypass.** `_ip_is_blocked` (`mcp_doc_fetcher/main.py:124`) does not normalize `::ffff:127.0.0.1` form to its IPv4 equivalent.
4. **A 260-LOC route file is fully implemented, fully tested, and never registered.** `services/agent-claw/src/routes/forged-tools.ts` — never imported by `index.ts`, so `skill_library.scope_promoted_at`/`scope_promoted_by` updates are unreachable in production.
5. **Two columns added by `12_security_hardening.sql:40-41` are read but never written.** `document_chunks.byte_start`/`byte_end` are read by `contextual_chunker` but never set by `doc_ingester/importer.py:120-128`. The PDF page-accuracy code path is dead.
6. **`make db.init` only re-applies `01_schema.sql`** — silently skips the other 15+ files. Developers editing `16_db_audit_fixes.sql` get no feedback.
7. **Two RLS-hot indexes are missing.** `user_project_access(user_entra_id, nce_project_id)` and `synthetic_steps(nce_project_id)` — every authenticated query is sequential-scanning these.
8. **Coverage is bimodal.** Hot harness paths ≥93% (775 vitest tests pass), but seven files hold all the debt. Five Python services have zero tests. Recommended PR-1 diff-cover thresholds: 75% TS / 70% Python with carve-outs for `routes/**`.

---

## Severity ranking and PR routing

### CRITICAL (P1) — fix immediately, lands as PR-0 BEFORE PR-1

| # | Finding | Source | Track | File:Line |
|---|---|---|---|---|
| C1 | Redactor `RXN_SMILES` regex CPU-DoS (~3.5s on 200KB adversarial input) — both Python and TS | `04-security-deps.md` §1 | D | `services/litellm_redactor/redaction.py:42`, `services/agent-claw/src/core/hooks/redact-secrets.ts:29` |
| C2 | SSRF IPv4-mapped-IPv6 bypass in `_ip_is_blocked` — `::ffff:127.0.0.1` reaches private network | `02-python-hotspots.md` §3.2, `04-security-deps.md` §3 | B, D | `services/mcp_tools/mcp_doc_fetcher/main.py:124` |
| C3 | LiteLLM gateway Dockerfile pinned to moving tag `:main-v1.60.0` (not a digest) | `04-security-deps.md` §2 | D | `services/litellm_redactor/Dockerfile:7` |
| C4 | Same Dockerfile lacks explicit `USER` directive (only Dockerfile in fleet missing it) | `04-security-deps.md` §2 | D | `services/litellm_redactor/Dockerfile:19` |
| C5 | `LocalSubprocessSandbox` runs LLM-authored forged-tool code without isolation; production must enforce E2B but nothing in code prevents accidental local-sandbox use | `04-security-deps.md` §4 | D | `services/optimizer/forged_tool_validator/sandbox_client.py:32-58` |
| C6 | `mock_eln/seed/generator.py` interpolates a path into a `\copy ... FROM PROGRAM` SQL template via f-string | `02-python-hotspots.md` §1.3 | B | `services/mock_eln/seed/generator.py:1076` |

**Routes to:** **PR-0 (NEW)** — Security P1 hotfix. Worktree `../chemclaw-secfix`. Single PR. Must land before any other Wave 2 work touches these files.

---

### HIGH (P2) — schema/correctness defects

| # | Finding | Source | Track | File:Line | Routes to |
|---|---|---|---|---|---|
| H1 | `make db.init` only re-applies `01_schema.sql`, silently skipping all subsequent files | `03-db-schema.md` §1 | C | `Makefile:87` | PR-8 |
| H2 | `user_project_access` has no composite index `(user_entra_id, nce_project_id)` — every RLS subquery is a seq scan | `03-db-schema.md` §5 | C | missing | PR-8 |
| H3 | `synthetic_steps.nce_project_id` FK has no index — every `experiments` RLS join unindexed | `03-db-schema.md` §5 | C | missing | PR-8 |
| H4 | `routes/forged-tools.ts` (260 LOC) fully implemented and tested but never registered in `index.ts`; production never sees scope-promotion updates | `07-deadcode-todos.md` §1 | G | `services/agent-claw/src/routes/forged-tools.ts` | PR-5 (decision: register OR delete with tests) |
| H5 | `document_chunks.byte_start`/`byte_end` columns added in `12_security_hardening.sql:40-41`, read by `contextual_chunker`, but never written by `doc_ingester` | `07-deadcode-todos.md` §2 | G | `services/ingestion/doc_ingester/importer.py:120-128` | PR-5 (decision: wire OR drop) |
| H6 | Streaming disconnects do not propagate to `runHarness` — client closes burn tokens silently | `07-deadcode-todos.md` §3 | G | `services/agent-claw/src/routes/chat.ts:632`, `routes/deep-research.ts:200` | PR-3 |
| H7 | `forge_tool` writes `${toolId}.py` without sanitization — path-traversal latent | `04-security-deps.md` §6 | D | (forge_tool builtin) | PR-0 (rolls into security) |

---

### MEDIUM (P3) — maintainability + minor correctness

| # | Finding | Source | Track | Routes to |
|---|---|---|---|---|
| M1 | `routes/chat.ts` 975 LOC — 770-line `handleChat` mixes 16 concerns; 4 near-duplicate SSE-finish blocks (lines 218/236/255/277) | `01-ts-hotspots.md` §1 | A | PR-6 |
| M2 | `routes/sessions.ts` 758 LOC — resume handlers at 278-322 and 376-417 are near-verbatim duplicates; 291-line `runChainedHarness` belongs in `core/` | `01-ts-hotspots.md` §2 | A | PR-6 |
| M3 | `index.ts` 565 LOC, 54 internal imports — God-file mixing 8 concerns | `01-ts-hotspots.md` §3 | A | PR-6 |
| M4 | `mcp_eln_local/main.py` 969 LOC — inlines SQL in every route; pool helpers should move to `common/` | `02-python-hotspots.md` §2 | B | PR-7 |
| M5 | `mcp_doc_fetcher/main.py` 728 LOC + latent unbound-name on pypdf-fallback path at line 524 | `02-python-hotspots.md` §3 | B | PR-7 |
| M6 | `mock_eln/seed/generator.py` 1135 LOC dominated by 650-LOC `generate()` with duplicated 80-LOC shape branching | `02-python-hotspots.md` §1 | B | PR-7 |
| M7 | `kg_hypotheses._handle_status_changed` sets `valid_to = datetime()` without idempotency guard — second replay advances timestamp | `03-db-schema.md` §7 | C | PR-5 (one-line cypher fix) |
| M8 | `with-user-context.ts:12` stale comment about empty-string permissive RLS (invalidated by `12_security_hardening.sql`) | `03-db-schema.md` §6 | C | PR-5 (doc-only) |
| M9 | Confidence model 3-way fragmentation: `reactions` tier-only, `hypotheses` numeric+3-tier, KG both 5-tier | `03-db-schema.md` §3 | C | PR-8 |
| M10 | `reactions`, `hypotheses`, `artifacts` lack `valid_from`/`valid_to` despite KG bi-temporal projection | `03-db-schema.md` §2 | C | PR-8 |
| M11 | `compact-window.ts:51`, `tag-maturity.ts:138`, `source-cache.ts:512` ignore `AbortSignal` — `compact-window` LLM call cannot be cancelled at 60s timeout | `06-boundary-audit.md` §8 | F | PR-3 (signal threading work) |
| M12 | `checkStaleFacts` exported in `source-cache.ts:380-404`, never registered as a hook — stale-fact warning silently absent | `06-boundary-audit.md` §5 | F | PR-5 (wire OR delete) |
| M13 | `plan/approve` constructs `ToolContext` without `lifecycle` field; mitigated by `harness.ts:57-59` filling it later — latent footgun | `06-boundary-audit.md` §F-3 | F | PR-5 (defensive: pass lifecycle explicitly) |
| M14 | `sandbox.ts` 6× `any` casts in SDK loader; `step.ts` 5× casts | `01-ts-hotspots.md` | A | PR-4 |
| M15 | 8 Python tests fail loudly when env config missing (5 doc_fetcher, 3 mcp_tabicl) — should self-skip | `05-coverage-baseline.md` §7 | E | PR-1 (test config) |
| M16 | `services/projectors/common/base.py` at 26% coverage — base class for all projectors | `05-coverage-baseline.md` §3 | E | PR-1 (changed-line gate forces coverage on touched code) |
| M17 | `uuid<14` moderate vuln via testcontainers chain — fix via `overrides`, NOT `audit fix --force` (which would break test infra) | `04-security-deps.md` §7 | D | PR-1 |
| M18 | Outdated deps with available bumps: `starlette 0.48`, `litellm 1.82.6`, `torch 2.2.2` | `04-security-deps.md` §8 | D | PR-1 |

---

### LOW (P4) — cleanups, doc fixes, deferred

| # | Finding | Source | Track | Routes to |
|---|---|---|---|---|
| L1 | `skill_library`/`forged_tool_tests` lack `maturity` column | `03-db-schema.md` §4 | C | PR-8 |
| L2 | `skill_library` has no DELETE RLS policy | `03-db-schema.md` §6 | C | PR-8 (or document service-only intent) |
| L3 | Stale `TODO` at `services/optimizer/session_reanimator/main.py:24` referencing ADR 006 (already implemented) | `07-deadcode-todos.md` §3 | G | PR-5 |
| L4 | Phase 6 permissions TODOs at `core/step.ts:160` and `core/types.ts:257` | `07-deadcode-todos.md` §3 | G | PR-5 (resolve OR explicitly defer with ADR link) |
| L5 | `lifecycle.ts:255` TODO referencing centralized pino logger | `07-deadcode-todos.md` §3 | G | PR-2 |
| L6 | `console.warn` calls in TS production paths (`config.ts:180`, `tools/registry.ts:322,392,440`, `core/step.ts:166`) | (CLAUDE.md confirmed) | – | PR-2 |
| L7 | Python services lack request correlation IDs (TS has it via middleware) | (CLAUDE.md confirmed) | – | PR-2 |
| L8 | Unused exports: `startToolSpan`/`startSubAgentSpan` (`spans.ts:90,105`), `SANDBOX_MAX_MEM_MB` (`sandbox.ts:51`), legacy `getSkillLoader`/`_resetSkillLoader` (`skills.ts:362,371`) | `07-deadcode-todos.md` §1 | G | PR-5 |
| L9 | `agent_sessions.session_token_budget` and `auto_resume_cap` rely on SQL DEFAULT only — no per-session override route | `07-deadcode-todos.md` §1 | G | (deferred — out of scope) |
| L10 | No ESLint at all for TS — only `tsc` | (CLAUDE.md baseline) | – | PR-1 |
| L11 | No pre-commit hooks | (CLAUDE.md baseline) | – | PR-1 |
| L12 | `mypy` defined in `pyproject.toml` but not run in CI | (CLAUDE.md baseline) | – | PR-1 |

---

## Updated PR landing order (9 PRs)

| Order | PR | Risk | Worktree | Lands when |
|---|---|---|---|---|
| 1 | **PR-0 (NEW): Security P1 hotfix** (C1–C6 + H7) | LOW | `../chemclaw-secfix` | First — small, high-priority, narrow scope |
| 2 | PR-1: Tooling baseline + dep hygiene (M15, M17, M18, L10–L12) | LOW | `../chemclaw-tooling` | After PR-0 |
| 3 | PR-2: Logging unification (L5, L6, L7) | LOW | `../chemclaw-logging` | After PR-1 |
| 4 | PR-5: Cleanup (H4 decision, H5 decision, M7, M8, M12, M13, L3, L4, L8) | LOW–MEDIUM | `../chemclaw-cleanup` | After PR-2 |
| 5 | PR-3: Streaming AbortSignal (H6, M11) | MEDIUM | `../chemclaw-streaming` | After PR-5 |
| 6 | PR-4: Type-safety hardening (M14) | MEDIUM | `../chemclaw-types` | After PR-3 |
| 7 | PR-7: Python God-file split (M4, M5, M6) | MEDIUM | `../chemclaw-py-split` | After PR-4 |
| 8 | PR-6: TS God-file split (M1, M2, M3) | HIGH | `../chemclaw-ts-split` | After PR-7 |
| 9 | PR-8: Schema unification + db.init fix (H1, H2, H3, M9, M10, L1, L2) | HIGH | `../chemclaw-db` | Last |

**Why PR-5 (cleanup) moved up:** the dead-route and dead-column decisions (H4, H5) are blockers for PR-6 and PR-8 respectively. Resolve early so later PRs don't fork on undecided state.

---

## Decisions required from user before PR-5

1. **`routes/forged-tools.ts` (H4):** register the route in `index.ts` (matches docstring intent) OR delete the file with its tests? Recommendation: register it — the table columns it updates exist, the tests pass, the feature was clearly intended to ship.
2. **`document_chunks.byte_start`/`byte_end` (H5):** wire `doc_ingester/importer.py:120-128` to populate these (PDF page-accuracy use case) OR drop the columns and the code in `contextual_chunker` that reads them? Recommendation: wire the writer — page-accuracy is a real product feature per the column comments.

---

## Verification before claiming Wave 2 done

After all 9 PRs land:

```bash
make nuke && make up && make db.init && make db.init  # second db.init = no-op
make lint                                              # 0 errors (ESLint + ruff + tsc + mypy)
make typecheck
make test                                              # ≥ 800 vitest, ≥ baseline pytest
make coverage                                          # diff-cover gate passes on each PR diff
./scripts/smoke.sh                                     # green
npm audit                                              # 0 high+ vulnerabilities
pre-commit run --all-files                             # clean
grep -rE 'TODO|FIXME|HACK|XXX' --include='*.ts' --include='*.py' | wc -l   # ≤ 2
```

Coverage targets after diff-cover gate is in place:
- TypeScript changed lines ≥ 75%
- Python changed lines ≥ 70% (60% for `routes/**`)

---

## Source reports (this directory)

| File | Track | Lines |
|---|---|---|
| `01-ts-hotspots.md` | A | 1014 |
| `02-python-hotspots.md` | B | 701 |
| `03-db-schema.md` | C | (this audit) |
| `04-security-deps.md` | D | 923 |
| `05-coverage-baseline.md` | E | 639 |
| `06-boundary-audit.md` | F | (this audit) |
| `07-deadcode-todos.md` | G | 550 |

---

*Wave 1 audit complete. Ready to execute Wave 2 starting with PR-0.*
