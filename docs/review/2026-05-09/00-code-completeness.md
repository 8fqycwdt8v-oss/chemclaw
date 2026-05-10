# Code-Completeness Review — 2026-05-09

Branch: `claude/code-completeness-review-XtWb7` (against `main` at 8cc5e20).

Scope: pass over the whole repo looking for missing features, missing
implementations, missing tests, missing wiring, and documentation drift.
Source-of-truth references are CLAUDE.md, AGENTS.md, BACKLOG.md, the ADRs,
the design plan, and the actual code on disk.

Findings are graded:

- **L1 — load-bearing gap.** Production path is broken or returns wrong
  results. Fix before claiming the feature works.
- **L2 — drift.** Code and docs disagree, or wiring is half-done. Confusing
  but not actively broken.
- **L3 — hygiene / debt.** Dead code, missing tests on covered paths, stale
  numbers. Worth tracking but not blocking.

A short backlog of new items to file is at the end.

---

## Executive summary

The repo is in good shape. The Phase A–F.2 scope CLAUDE.md claims is broadly
real: services, ports, registry tables, RLS policies, hook/lifecycle
registrars, synthesis-campaign infrastructure (2026-05-08), Wave-2 audit
deliverables. Documented features have on-disk evidence; the ADRs and
runbooks are present and substantive.

What the audit found is a thin layer of incompleteness on top of that:

- One genuine `NotImplementedError` on a load-bearing code path
  (`workflow_engine` `loop` step kind).
- A handful of intentional 501s (real LOGS backend, REINVENT, g-xTB) where
  the gate is external (tenant access, vendor library, binary).
- One placeholder evaluation runner (ChemBench scoring, Phase Z7).
- One outright dead table (`corrections`).
- One out-of-compose, out-of-tests doc-only "MCP service"
  (`mcp_instrument_template`).
- Modest test coverage gaps: 36 of 87 agent-claw builtins lack a *dedicated*
  unit test (most are smoke-covered), 7 of 24 MCP services have no
  `tests/` directory at all, 9 core harness modules have no unit suite.
- Soft drift in CLAUDE.md numbers (test counts, runbook list, schema_version
  recording) — none of it dangerous, but it makes the doc easier to mistrust.

---

## L1 — load-bearing gaps

### L1-1. `workflow_engine` `loop` step kind raises `NotImplementedError`

`services/workflow_engine/main.py:271-281` rejects the `loop` step kind with
`NotImplementedError` and a docstring telling the caller to "express
iteration via 'parallel' (fan-out) or call multiple tool_call steps
explicitly." The other six step kinds (`tool_call`, `wait`, `conditional`,
`parallel`, `sub_agent`, plus any `wait` variant) are functional.

Impact: any workflow definition that uses `loop` fails at execute-time.
The workaround is real but pushes the iteration count out to definition
time, so dynamic-bound loops (e.g. "iterate until residual < ε") cannot be
expressed.

This is the single hard `NotImplementedError` in a non-stub code path. Either
delete the `loop` kind from the step-kind union (so the schema rejects it
at submit-time), or implement it. Today the agent can author a workflow
that the engine will refuse, with no static check.

### L1-2. `corrections` table is dead

`db/init/01_schema.sql:67-78` defines `corrections` (user-submitted KG
corrections). Zero readers, zero writers, no admin route, no projector
consumes it. CLAUDE.md describes "explicit contradiction handling" as a
defining characteristic of the KG; this is one of the obvious places it
would live, and it isn't wired.

Either delete the table (and document the actual contradiction-handling
path, which today is `hypotheses.refuted_at` + the `kg_hypotheses`
projector), or wire a writer.

### L1-3. ChemBench evaluation returns `passed=False` for everything

`services/optimizer/eval_chemistry/eval_chembench_subset.py:54-62` returns
`status="placeholder"`, `passed=False` for every task. The `/eval` slash
verb routes through this and "succeeds" in the sense that the runner
doesn't crash, but the score for every ChemBench question is a lie. If
anyone reads the eval dashboard expecting ChemBench scores, they're
reading zeros. This needs either an end-to-end implementation or a
clear "not scored" state in the result envelope so the dashboard
stops rendering it as a failure.

---

## L2 — drift between code and docs

### L2-1. Intentional 501s should be visible in CLAUDE.md, not just in code

Three explicit `not_implemented` paths:

- `services/mcp_tools/mcp_logs_sciy/backends/real_logs_sdk.py:48-65` — five
  endpoints raise `NotImplementedError` until a real LOGS tenant is
  available (plan §11 Q1).
- `services/mcp_tools/mcp_xtb/_shared.py:67-71` — g-xTB returns 501 because
  the binary isn't bundled (the previous behaviour silently fell back to
  GFN2 and poisoned the cache; the fail-closed is correct).
- `services/mcp_tools/mcp_genchem/main.py:667-676` — `/reinvent_run` 501s
  because REINVENT isn't bundled.

These are documented in code but not in CLAUDE.md's status section, where
the chemistry-MCP bullet reads as if all of askcos/aizynth/chemprop/xtb
/synthegy-mech/sirius are fully functional. A one-line caveat under the F.1
bullet ("g-xTB binary not bundled; method returns 501") and under
mcp_logs_sciy ("`real` backend stubbed pending tenant access") would close
the gap.

### L2-2. `_exec_sub_agent` is fully wired but its module docstring still calls it a placeholder

`services/workflow_engine/main.py:9` says "_exec_sub_agent: placeholder;
future hook into the agent's sub-agent dispatch path." The actual function
(line 357 onward) mints a JWT, posts to `/api/internal/sub-agents`, parses
the streamed response, and is exercised by tests. Either the docstring is
out of date, or the module-level note is referring to something narrower
that was never specified. Update the comment.

### L2-3. Runbook enumeration in CLAUDE.md is one short

CLAUDE.md lines 246–256 list 11 runbooks. `docs/runbooks/` has 12; the new
`synthesis-campaign-lifecycle.md` is referenced in prose under the
2026-05-08 status bullet but missing from the enumeration. Add it.

### L2-4. Test counts in CLAUDE.md are stale

CLAUDE.md "Test counts (current branch)":

| Suite | Claim | Actual (rough) |
|---|---|---|
| `services/agent-claw npm test` | 1118 / 153 files | ~1388 cases / 182 files |
| `services/paperclip npm test` | 23 | matches |
| `services/mcp_tools/common/tests/` | 87 | 88 |
| `services/queue + workflow_engine + paperclip` (pytest) | 18 | ~41 |

The agent-claw and queue/workflow numbers are conservative by 20–130%.
This kind of drift is the reason the rule is "verify before claiming
done"; the numbers should be regenerated whenever they're touched, or
removed in favour of a `make test-counts` target.

### L2-5. `schema_version` recording is inconsistent

BACKLOG.md notes 8 of 46 init files record. Today the count is 11 of 51.
Files that don't record include the foundational ones (00–18, 20–22,
30–31, 33–38, 40–47). Either every file appends a `schema_version` row
(consistent, easy to lint with a pre-commit), or the table is decommissioned
and replaced with a real migration tool. The current state — partial
coverage — is the worst of both: you can't query "what's applied?" with
confidence, but the table is non-empty so it looks like you can.

### L2-6. `mcp_instrument_template` is a doc-only stub

`services/mcp_tools/mcp_instrument_template/` has no `main.py`, no
`Dockerfile`, no `requirements.txt`, no compose entry, no tests. ADR 005
references it as an exemplar template. If it's a template, it should
either have a runnable skeleton (so copy-paste works) or be moved to
`docs/templates/` and renamed. Today a developer who follows the
"adding a new MCP tool service" runbook and looks for a working example
will be confused.

### L2-7. Synthesis-campaign `ref_table`/`ref_id` is a soft FK

`db/init/51_synthesis_campaigns.sql:150-156` constrains `ref_table` to a
fixed enum of table names but `ref_id` is a `TEXT` and there is no
referential integrity. Deleting an `optimization_campaigns` row leaves
dangling `synthesis_campaign_steps.ref_id` pointers with no warning. This
is sometimes acceptable (e.g. cross-schema references to `mock_eln.entries`
are out of reach for FKs) but the trade-off should be called out in the
ADR; today it isn't. At minimum, add a periodic integrity-check view that
surfaces orphans.

### L2-8. Logger does not redact `err.message` / `err.stack`

Already on the 2026-05-03 deep-review backlog (cluster 6) and acknowledged
in CLAUDE.md, but worth re-flagging here since it intersects the redaction
posture: Postgres and MCP error messages routinely embed SMILES and
compound codes, and the Pino redact list does not include `err.message` /
`err.stack`. The shared `redact-string.ts` primitive (Wave-2) exists; the
remaining work is to plumb it through the error serializer.

---

## L3 — hygiene / coverage debt

### L3-1. 36 of 87 agent-claw builtins have no dedicated unit test

55 builtins have a matching `tests/unit/builtins/<name>.test.ts`; 36 do
not. Many of the 36 are exercised by `phase_3_to_9_smoke.test.ts` and
the synthesis-campaign integration tests, so the actual untested count
is smaller than 36, but the gap list is worth keeping somewhere
discoverable. Notable items in the gap that look load-bearing:

- All seven synthesis-campaign builtins (`start_synthesis_campaign`,
  `list_synthesis_campaigns`, `get_synthesis_campaign`,
  `add_synthesis_campaign_step`, `update_synthesis_campaign_step`,
  `advance_synthesis_campaign`, `record_synthesis_campaign_outcome`).
  Some are integration-tested but none has a unit test that exercises
  the JMESPath / state-transition logic in isolation.
- `manage_todos` and `ask_user` — the two driving builtins for
  persistent agent sessions per CLAUDE.md.
- `workflow_*` family (define / inspect / modify / pause_resume / replay
  / run).
- `qm_*` family (geometry_opt, frequencies, fukui, redox_potential,
  crest_screen).
- `recommend_next_batch`, `start_optimization_campaign`,
  `ingest_campaign_results`, `run_chemspace_screen`,
  `generate_focused_library` — all in BO/screening campaign paths.

The full list is reproducible with:

```sh
comm -23 \
  <(find services/agent-claw/src/tools/builtins -maxdepth 1 -name "*.ts" \
       -not -name "_*" -not -name "*.test.ts" -printf "%f\n" \
       | sed 's/\.ts$//' | sort) \
  <(find services/agent-claw/tests -path "*builtins*" -name "*.test.ts" \
       -printf "%f\n" | sed 's/\.test\.ts$//' | sort)
```

### L3-2. 7 MCP services have no `tests/` directory

`mcp_doc_fetcher`, `mcp_drfp`, `mcp_embedder`, `mcp_instrument_template`
(addressed above), `mcp_kg`, `mcp_rdkit`, `mcp_tabicl`. BACKLOG flags
`mcp_drfp` and `mcp_rdkit` for diff-cover; the other four aren't on the
list. `mcp_rdkit` and `mcp_drfp` are heavily exercised end-to-end by the
projector tests, so the absence is less alarming than it looks, but
unit coverage of the ValueError paths (bad SMILES, etc.) belongs at the
service.

### L3-3. 9 core harness modules lack unit suites

`chained-harness`, `hook-output`, `plan-store-db`, `request-context`,
`run-one-tool`, `runtime`, `session-state`, `step`, `types` under
`services/agent-claw/src/core/` have no dedicated `*.test.ts`. They're
exercised through `harness.test.ts` and the integration trio, so the
behaviour is covered, but several of them (`session-state`,
`plan-store-db`, `request-context`) own load-bearing invariants —
RLS context propagation, ETag conflict handling, scratchpad
hydration — that benefit from focused unit tests.

### L3-4. Projector idempotency is implicit

10 of 11 projectors rely on `projection_acks` as the de-dupe guard
rather than `ON CONFLICT DO NOTHING` on their own writes (the exception
is `qm_kg`). The current single-LISTEN-handler design makes this safe
in practice, but a future change to multiple workers or a bug in the
ack path would silently produce duplicates. Cheap to fix: add the
`ON CONFLICT` clause everywhere the projector writes, and let the
unique constraints do the heavy lifting.

### L3-5. Builtin tool registry is import-driven

There is no central `index.ts` / `registry.ts` listing the builtins;
they're imported wherever they're routed. This is fine for runtime but
makes "show me every builtin" a `find` query, and means a stale import
doesn't fail at boot. A generated registry file (or an `assert
builtins.length === N` at startup) would catch drift.

### L3-6. BACKLOG.md is large but not stale

138 entries; 26 explicitly marked DONE; no obviously stale entries that
contradict the CLAUDE.md "Wave-2 audit closed" claim. Several
entries have been silently overtaken (e.g. compound-classifier
advisory lock landed in Wave-2 but the BACKLOG entry could be promoted
to DONE). A 10-minute pass through to mark these would help.

---

## What was checked and is solid

- All declared service ports (3101 + 8001–8013, 8016) match
  `docker-compose.yml` and the service code.
- All seven synthesis-campaign builtins, the `/synthesize` slash verb,
  the `agent.synthesis_planner` prompt mode (`db/seed/03_synthesis_planner_prompt.sql`),
  ADR 011, and the runbook are present.
- All 21 hook YAMLs match `BUILTIN_REGISTRARS` in `hook-loader.ts`;
  `MIN_EXPECTED_HOOKS = 21` is correct; the 9 lifecycle-telemetry stubs
  are real handlers, not no-ops.
- All 12 runbooks exist and are >30 non-empty lines with no TODO/TBD
  markers.
- `config_settings`, `feature_flags`, `permission_policies`,
  `redaction_patterns`, `admin_roles`, `admin_audit_log` all exist with
  callers, admin routes, and (where applicable) seeds.
- 112 tables have RLS enabled; 95 have policies; no orphan RLS tables.
- Bi-temporal columns on `reactions` / `hypotheses` / `artifacts` exist
  *and* have writers (the previous concern that they were structural-only
  is unfounded — `update_hypothesis_status` and the artifact-supersession
  paths set them).
- Custom NOTIFY channels (DR-06) for `compound_fingerprinter` and
  `compound_classifier` have docstrings naming the channel and payload
  semantics, as CLAUDE.md requires.
- The `source-cache` regex `/^(query|fetch)_(eln|lims|instrument)_/`
  matches all 12 F.2 builtin names that should trigger caching.
- `services/ingestion/eln_json_importer.legacy/` exists; the live path
  is retired as documented.
- `infra/helm/` exists with `Chart.yaml`, `values.yaml`, `templates/`.

---

## Items to file in BACKLOG.md

```
- [workflow_engine] decide loop step-kind: implement or remove from union
- [optimizer/eval_chemistry] ChemBench placeholder returns passed=False — gate runner or implement
- [db/schema] corrections table is dead — wire a writer or drop
- [docs/CLAUDE.md] add 501-caveat lines under F.1 (g-xTB) and F.2 (mcp_logs_sciy real backend)
- [docs/CLAUDE.md] add synthesis-campaign-lifecycle.md to the runbooks enumeration
- [docs/CLAUDE.md] regenerate test-counts block or replace with a make target
- [services/workflow_engine] update _exec_sub_agent module docstring (no longer placeholder)
- [db/schema] schema_version recording — make every init file append a row, or decommission the table
- [services/mcp_tools/mcp_instrument_template] either give it a runnable skeleton or move to docs/templates/
- [db/init/51_synthesis_campaigns] document the soft-FK trade-off; add an orphan-detection view
- [observability] plumb redact-string through the Pino error serializer (err.message / err.stack)
- [tests] add unit suites for the seven synthesis-campaign builtins
- [tests] add unit suites for manage_todos, ask_user, workflow_* family
- [tests] add tests/ directories for mcp_doc_fetcher, mcp_embedder, mcp_kg, mcp_tabicl
- [tests] add focused unit tests for core/{session-state, plan-store-db, request-context}
- [services/projectors] add explicit ON CONFLICT DO NOTHING to the 10 projectors that rely on projection_acks
- [services/agent-claw/tools] generate a registry of builtins; assert count at startup
- [BACKLOG] sweep for entries overtaken by Wave-2 / synthesis-campaign work and mark DONE
```
