# Tier 4 / A18 — Testing-Completeness Audit

**Date:** 2026-05-05
**Base commit:** `58d3936` (post-PR-#97)
**Scope:** add 2–4 high-leverage unit tests on uncovered paths the merged
PRs deliberately marked `# pragma: no cover` and noted in `BACKLOG.md`.
Defer testcontainer round-trips and end-to-end integration to the
existing BACKLOG entries.

---

## Tests added

| File | Cases | What it locks |
|---|---|---|
| `services/mcp_tools/mcp_yield_baseline/tests/test_auth_headers.py` | 4 | DR-12 Bearer-auth fan-out: `_encode_drfp_batch` and `_call_chemprop_batch` send `Authorization: Bearer ...` minted via `McpTokenCache` when `MCP_AUTH_SIGNING_KEY` is set, and omit the header in dev mode. Decoded JWTs verify the right `aud` (`mcp-drfp` / `mcp-chemprop`) and scope. |
| `services/queue/tests/test_backoff.py` | 15 | The `min(30 * (2 ** (attempts - 1)), 3600)` exponential-backoff schedule from PR #87. Parametric across attempts 1–8 (clamp engages at 8), monotonicity guard, never-exceeds-1h guard, and a literal-source assertion that catches drift between the test mirror and production. |
| `services/agent-claw/tests/unit/routes/optimizer-route.test.ts` | 9 | All four `/api/optimizer/*` GETs were route-untested (BACKLOG-80). Verifies admin gate (403 for non-admin) on every endpoint and 200 + correctly-keyed bodies (`runs` / `events` / `shadows` / `scores`) on the happy path with a SQL-fragment-matching `pg.Pool` stub. |
| `services/mcp_tools/common/tests/test_redaction_filter.py` (extended) | +3 | DR-14 redaction edge cases: `stack_info` populated without `exc_info`; chained-exception (`raise ... from ...`) tracebacks; multi-frame stacks with multiple SMILES / `CMP-…` / `NCE-…` secrets — every occurrence must be redacted. |

**Net delta:** 4 new test files / extensions, 31 new test cases.

```
services/mcp_tools/common/tests/             8 → 11   (+3)
services/mcp_tools/mcp_yield_baseline/tests/ 18 → 22  (+4)
services/queue/tests/                        4 → 19   (+15)
services/agent-claw/tests/unit/routes/       16 → 25  (+9)
```

## Run results

```
.venv/bin/pytest services/mcp_tools/common/tests/ \
                 services/queue/tests/ \
                 services/mcp_tools/mcp_yield_baseline/tests/ -q
→ 135 passed in 6.97s

npm test --workspace services/agent-claw
→ 1127 tests / 154 files passed in 66 s   (was 772+ at last CLAUDE.md update)

.venv/bin/pytest services/projectors/kg_source_cache/tests/ -q
→ 7 passed   (regression sanity check on adjacent code)
```

## Coverage delta where measurable

The tests target paths that are explicitly excluded from coverage in
`pyproject.toml` `[tool.coverage.run].omit` / CI `--exclude` (BACKLOG'd
testcontainer paths), so the line-coverage % won't move on the
omit-listed files. The behavioural-coverage delta is the real
deliverable:

- **mcp_yield_baseline auth fan-out** — previously zero direct assertion
  that the merged DR-12 fix actually mints + sends a JWT. Two of the
  four new cases would have caught a deletion of either `headers=...`
  kwarg.
- **Queue backoff** — the formula was untested at the unit level (the
  full method is `pragma: no cover` pending testcontainer setup). The
  parametric table + literal-source guard makes refactor accidents loud.
- **Optimizer routes** — admin gate previously had no automated test;
  any regression in `gateAdmin` (e.g., flipping from `has_admin=true` to
  `false`) would silently 200 every endpoint to non-admins. Now 403 is
  pinned at four entry points.
- **Redaction filter** — base case (rendered exc_text) was already
  pinned in PR #93. Three extra cases close the `stack_info`-only,
  chained-exception, and multi-secret-traceback paths.

## Deferred — explicitly NOT addressed here

These are kept on `BACKLOG.md` per the audit prompt's instruction not to
add unit tests against omit-listed components:

- `kg_source_cache` projector full round-trip (UUID-cast bug fixed in
  PR #87): existing `test_kg_source_cache.py` already covers the
  handler-level invariants with mocked `kg.write_fact`. A real
  Postgres-driven round-trip needs a testcontainer harness (Docker on
  CI) that doesn't exist yet — BACKLOG'd.
- `services/queue/worker.py::_maybe_retry` end-to-end (DB write of
  `retry_after = NOW() + backoff_seconds`): requires a real Postgres
  + advisory-lock-aware testcontainer. BACKLOG'd.
- `services/optimizer/session_reanimator`, `services/projectors/kg_hypotheses`,
  `services/mcp_tools/mcp_drfp`, `services/mcp_tools/mcp_rdkit`,
  `services/queue` (CI `--exclude`): all flagged in BACKLOG with
  `>30%` coverage targets pending the testcontainer infra.
- `services/agent-claw/src/routes/forged-tools.ts` route-handler tests:
  the existing `tests/unit/routes/forged-tools-route.test.ts` only
  re-implements the `isAdmin` predicate in JS rather than driving the
  fastify handler. A handler-level test would need `isAdmin` mocked
  out (it queries `admin_roles` directly via raw `pool.query`, not
  through `withUserContext`); the SQL-fragment stub used for the
  optimizer route isn't a clean fit. Filing as BACKLOG follow-up.

## BACKLOG additions

- [agent-claw/forged-tools] handler-level test for `/api/forged-tools/:id/scope` and `/disable` — current test only covers a JS reproduction of `isAdmin`, not the Fastify route. Needs a `mockIsAdmin` shim because the production handler bypasses `withUserContext` for the admin check.
- [mcp_yield_baseline] coverage-pragma cleanup — the inner `with httpx.Client(...)` block carries `# pragma: no cover` for "fan-out path mocked at the function boundary"; with the new auth-header tests it IS covered, so the pragma is now misleading.

## Files touched

- `services/mcp_tools/mcp_yield_baseline/tests/test_auth_headers.py` (new, +119 lines)
- `services/queue/tests/test_backoff.py` (new, +85 lines)
- `services/agent-claw/tests/unit/routes/optimizer-route.test.ts` (new, +163 lines)
- `services/mcp_tools/common/tests/test_redaction_filter.py` (+88 lines)
- `docs/review/2026-05-05/18-testing-completeness.md` (this file)

No production code changed; no commits made.
