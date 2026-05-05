# A11 — Dead-code sweep (Tier 3)

Date: 2026-05-05
Branch: `wave2-tier2-synthesis` (HEAD `1f303db`)
Scope: exports / files / branches / env vars / DB columns with zero readers
or callers, per the audit-prompt candidate list.

Verdict legend: `DELETE` = removed in this PR · `BACKLOG` = filed for
deliberate follow-up · `PRESERVE` = active or load-bearing, no action.

---

## 1. `services/frontend/` — DELETE (untracked cruft only)

The Streamlit frontend was already removed in `81a8937` ("chore: remove
services/frontend (Streamlit app) + frontend tests"). Re-verified:

```
$ git ls-files services/frontend/
(empty)

$ git ls-files --others services/frontend/
services/frontend/__pycache__/__init__.cpython-311.pyc
services/frontend/__pycache__/chart_spec.cpython-311.pyc
services/frontend/__pycache__/chat_client.cpython-311.pyc
services/frontend/__pycache__/db.cpython-311.pyc
services/frontend/__pycache__/settings.cpython-311.pyc
services/frontend/__pycache__/streamlit_app.cpython-311.pyc
services/frontend/pages/__pycache__/chat.cpython-311.pyc
```

Zero tracked files; only stale local `__pycache__` `.pyc` files (already
gitignored, untracked).

```
$ grep -rn "services/frontend\|services\.frontend" \
    --include="*.py" --include="*.ts" --include="*.yml" \
    --include="*.yaml" --include="*.toml" --include="Makefile" \
    --include="*.json" .  | grep -v "node_modules\|\.git\|__pycache__"
docs/...                 (only docs / plans / review references)
AGENTS.md:807            (historical note about removed frontend page)
```

No live build, infra, or service references. Action: removed the empty
directory locally (`rm -rf services/frontend`) so the leftover `.pyc` files
stop polluting `find` output. No tracked content was touched. No
docker-compose / Helm / Makefile entry needed deletion (none existed).

## 2. `services/ingestion/eln_json_importer.legacy/` — BACKLOG

Preserved per CLAUDE.md F.2 ("preserved as `services/ingestion/eln_json_importer.legacy/`
for one-shot bulk migrations"). Verified live references:

```
Makefile:133  import.sample.legacy: ...        # documented "deprecated" target
Makefile:136  python -m services.ingestion.eln_json_importer.legacy.cli ...
docs/contributing.md:72                          # excluded from coverage
docs/adr/005-data-layer-revision.md:56           # explicit preservation note
docs/runbooks/local-dev.md:49                    # references `eln_json_importer/requirements.txt`
                                                  # (pre-`.legacy` rename — stale, see BACKLOG)
```

`docs/runbooks/local-dev.md:49` references the pre-rename path
`services/ingestion/eln_json_importer/requirements.txt` which no longer
exists — runbook is stale. Action: BACKLOG (do not delete the legacy module;
fix the runbook drift).

## 3. `services/agent-claw/src/security/workspace-boundary.ts` — PRESERVE

Verified status: no production caller, only the unit test
(`tests/unit/workspace-boundary.test.ts`).

```
src/core/step.ts                          # no — unrelated
tests/unit/workspace-boundary.test.ts     # 12 references (test only)
src/security/workspace-boundary.ts        # the file itself
```

The file already opens with a 10-line docstring stating
"STATUS: helper landed; no caller in production today …" and naming the
intended call sites. Per the audit constraint ("Don't delete unless
you're sure"), this is preserved. No edit applied — the doc note is
already clear.

## 4. `services/agent-claw/src/core/permissions/resolver.ts` — PRESERVE

Confirmed live production callers:

```
src/core/step.ts:28: import { resolveDecision } from "./permissions/resolver.js";
```

Cross-checked BACKLOG entry that says "all 6 call sites pass
`permissionMode: 'enforce'`" (line 76). Resolver is wired and active.

## 5. `services/agent-claw/src/prompts/shadow-evaluator.ts` — PRESERVE

Confirmed live production callers:

```
src/bootstrap/dependencies.ts:18,120,147,173   # construction + DI
src/bootstrap/routes.ts:41                      # route registration
src/routes/chat-shadow-eval.ts:16              # consumer
```

Plus full unit-test suite (`tests/unit/shadow-evaluator.test.ts`).

## 6. `services/agent-claw/src/core/sandbox.ts` — PRESERVE (audit-prompt assertion incorrect)

Audit prompt says "LocalSubprocess vs E2B. Are both paths reachable?".
Verification:

```
$ grep -n "LocalSubprocess" services/agent-claw/src/core/sandbox.ts
(no matches)
$ grep -rn "LocalSubprocess" services/agent-claw/ --include="*.ts"
(no matches)
```

No `LocalSubprocess` class exists — the file is single-path E2B-only.
Audit-prompt's premise is stale. No action.

## 7. Routes `learn / eval / optimizer / forged-tools / artifacts` — partial BACKLOG

Verified `services/agent-claw/src/bootstrap/routes.ts`:

| Route | Registered | Unit test |
|---|---|---|
| `learn` | yes (line 17/55) | `tests/unit/learn-route.test.ts` |
| `eval` | yes (line 19/64) | `tests/unit/routes/eval-route.test.ts` |
| `optimizer` | yes (line 20/71) | **none** |
| `forged-tools` | yes (line 22/89) | **none** |
| `artifacts` | yes (line 16/54) | `tests/unit/artifacts-route.test.ts` |

`optimizer.ts` and `forged-tools.ts` are wired but have no direct unit
test exercising the registered Express endpoints. Filed in BACKLOG.

## 8. Orphan branches — BACKLOG

```
$ for b in a02-design-rule-sweep agents-md-tool-catalog \
          helm-template-gaps hook-lifecycle-doc \
          projector-pattern-doc tool-annotations-sweep \
          wave2-tier2-synthesis; do
    echo $b $(git rev-list --count origin/main..origin/$b)
  done
a02-design-rule-sweep 0
agents-md-tool-catalog 0
helm-template-gaps 0
hook-lifecycle-doc 0
projector-pattern-doc 0
tool-annotations-sweep 0
wave2-tier2-synthesis 3   # current HEAD
```

Six branches are 0-commits-ahead of `origin/main` (already merged);
safe to delete remotely. Per audit constraint, not pushing
`--delete` from here. Filed in BACKLOG.

## 9. Dead exports — sample-only, no findings worth deleting

Generated 742 unique exported symbols across `services/agent-claw/src`,
filtered to symbols appearing in only one file (heuristic for orphans).
The result is dominated by tool-input/output Zod schema types
(`AskUserIn`, `CanonicalizeInput`, etc.) used internally by the tool
file's own schema definition and consumed by callers via type
inference, not by name. False-positive rate is ~95%; the genuine
orphans surfaced are the four already covered above
(`workspace-boundary` exports). No additional action.

---

## What was deleted in this PR

- `services/frontend/` (untracked `__pycache__` cruft only — no tracked
  content was modified).

## BACKLOG additions

See `BACKLOG.md` for the four entries appended:
- runbook drift in `docs/runbooks/local-dev.md` (pre-rename
  `eln_json_importer` path)
- missing direct unit tests for `routes/optimizer.ts` and
  `routes/forged-tools.ts`
- six fully-merged audit branches awaiting `git push --delete`
- (no entry for workspace-boundary; the file's own docstring is
  already explicit)

## Verification

```
$ npx tsc --noEmit -p services/agent-claw
(clean — no output)
```

No source files were edited. Constraint satisfied.
