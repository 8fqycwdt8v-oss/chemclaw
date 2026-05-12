# Stub / mock / not-implemented inventory

Audit date: 2026-05-12. Sweep of every `NotImplementedError`, HTTP `501`,
`StubX`, `fake_*`, `mock_*`, and "placeholder" surface in the tree, plus a
verdict on each: is it the intended design, blocked on something that cannot
live in this repo, or actionable here.

Inline `TODO` / `FIXME` count: **0**. Incomplete work is tracked in
`BACKLOG.md`, not scattered through comments. This file is the consolidated
view of the *deliberately-degraded* surfaces and what would lift each one.

Legend:

- **DESIGN** — intentional and permanent. The "stub" *is* the product (mock
  source systems, dev-only test doubles). Not a defect; do not "fix".
- **BLOCKED-EXT** — a real implementation exists in principle but needs a
  licensed binary, a vendor SDK, tenant credentials, or a published corpus
  that cannot be committed here. Correct behaviour today is to fail closed
  (501 / `NotImplementedError`). Tracked; unblock per the noted prerequisite.
- **ACTIONABLE** — can be done in-repo; see `BACKLOG.md` for the work item.

---

## 1. Mock source systems — DESIGN

ChemClaw has **no real ELN / LIMS / SDMS vendor integration**. Phase F.2
shipped self-contained, deterministic, Postgres-backed stand-ins on purpose
so the agent, projectors, and source-cache hook have something to exercise
end-to-end. These stay.

| Surface | Path | Notes |
|---|---|---|
| Mock ELN service | `services/mcp_tools/mcp_eln_local/` | Real FastAPI service over the `mock_eln` schema (`db/init/30_mock_eln_schema.sql`, seed `db/seed/20_mock_eln_data.sql`, ≥2000 experiments / 4 projects / 10 chemistry families / 10 OFAT campaigns). Citations `local-mock-eln://…`. FORCE RLS via `db/init/49_*.sql`. |
| Fake LOGS (SciY) backend | `services/mcp_tools/mcp_logs_sciy/backends/fake_postgres.py` | Real keyset-paginated backend over the `fake_logs` schema (`db/init/31_*.sql`, seed `db/seed/21_*.sql`, ~3000 datasets cross-linked to `mock_eln.samples`). The default `LOGS_BACKEND`. |
| Stub embedder | `services/mcp_tools/mcp_embedder/encoder.py` (`StubEncoder`) | Deterministic hash-derived vectors; dev-only fallback when `embed_model_name="stub-encoder"` so unit tests don't pull BGE-M3. Logs "dev-only — not semantic". |
| Local subprocess sandbox / stub sandbox | `services/optimizer/forged_tool_validator/sandbox_client.py` (`LocalSubprocessSandbox`, `StubSandboxClient`) | `LocalSubprocessSandbox` is opt-in (`CHEMCLAW_ALLOW_LOCAL_SANDBOX=1`), dev/CI only, NO isolation — production uses the E2B client. `StubSandboxClient` is a test double. |
| Mock parity harness | `services/agent-claw/tests/.../*.json` scenarios | Claude-SDK parity fixtures. Test infra. |
| `mcp_instrument_template` | `services/mcp_tools/mcp_instrument_template/` | Intentional copy-me skeleton for vendor instrument adapters; every route is `501` by design. Now a runnable skeleton (main/requirements/Dockerfile/tests) — copy and replace `_fetch_run` / `_search_runs`. |

Hardening (keep mock, tidy edges) — see `BACKLOG.md`:
`mcp_eln_local` mypy clean subset, `mcp_logs_sciy` real-vs-fake auth-path
tests, MCP-response redaction defense-in-depth for the mock payloads.

---

## 2. Blocked on external software / credentials — BLOCKED-EXT

These return `501` / `NotImplementedError` **on purpose** (fail closed —
e.g. the g-xTB guard exists precisely because the old code silently fell
back to GFN2 and poisoned the result cache). None can be made "real" inside
this repo.

| Surface | Path | Returns | Prerequisite to unblock |
|---|---|---|---|
| Real LOGS-by-SciY backend | `services/mcp_tools/mcp_logs_sciy/backends/real_logs_sdk.py` | `NotImplementedError` on all 5 methods | `logs-python` SDK + a live LOGS tenant + tenant access config (`docs/plans/eln-mock-and-logs-sciy.md` §11 Q1) |
| `mcp_genchem` `/reinvent_run` | `services/mcp_tools/mcp_genchem/main.py` | `501 not_implemented` | REINVENT (separately-licensed generative model) bundled in the image. Use `scaffold_decorate` / `bioisostere_replace` / `fragment_grow` meanwhile. |
| `mcp_xtb` g-xTB method | `services/mcp_tools/mcp_xtb/_shared.py` (`method_flags`), guard in `main.py` | `501` before subprocess/cache | Standalone `gxtb` binary (Grimme group; not an `xtb` subcommand) wired into `mcp_xtb/Dockerfile` + parsers + `_gxtb_available()` flip. `BACKLOG.md` `[mcp_xtb/g-xtb]`. Also a one-shot SQL to invalidate any pre-fix `method='g-xTB'` cache rows. |
| `mcp_xtb` `/transition_state` | `mcp_xtb/main.py` | `501` | `xtb-path` / pyGSM driver in the image |
| `mcp_xtb` `/irc` | `mcp_xtb/main.py` | `501` | `xtb-irc` driver in the image |
| `mcp_xtb` `/metadynamics` | `mcp_xtb/main.py` | `501` | CV-definition + bias-input contract (route reserved) |
| `mcp_xtb` `/nci` | `mcp_xtb/main.py` | `501` | NCIPLOT integration (route reserved) |
| `mcp_xtb` `/nmr_shieldings`, `/excited_states` | `mcp_xtb/main.py` | `501` if `stda`/build lacks it | sTDA binary present in the image |
| `mcp_xtb` `/pka` | `mcp_xtb/main.py` | `501` | **By design** — delegated to `mcp-crest` (`CREST -pka`). Not a gap. |
| `mcp_crest` endpoints | `services/mcp_tools/mcp_crest/main.py` | `503` on `/readyz` if `crest` not on PATH | `crest` binary in the image. Conditional, not a stub. |
| `mcp_sirius` endpoints | `services/mcp_tools/mcp_sirius/main.py` | `503` if `sirius` not on PATH | `sirius` binary. Conditional. |
| `mcp_doc_fetcher` `s3://` / `smb://` / `sharepoint://` | `services/mcp_tools/mcp_doc_fetcher/main.py` | `501 not_implemented` | Provider clients (boto3 / pysmb / Graph SDK). `file://` + `http(s)://` are wired. Tracked as "Phase F" providers. |
| ASKCOS / AiZynth / Chemprop chemistry MCPs | `services/mcp_tools/mcp_askcos|mcp_aizynth|mcp_chemprop/` | `503` if model dir missing | Model checkpoints mounted (`ASKCOS_MODEL_DIR` etc.). Code is real; gated on data. |
| Cross-project KGE / motif transfer | `db/init/54_*.sql`, `BACKLOG.md` "Cross-project KG transfer" | tables exist, no callers | Public-corpus licensing clearance + ADRs + multi-week build (`docs/research/kg-transfer-learning.md`) |

---

## 3. Lifecycle telemetry hooks — DESIGN (intentional thin handlers)

`services/agent-claw/src/core/hooks/lifecycle-telemetry.ts` + the 9
`hooks/<point>-telemetry.yaml` files implement the 9 dispatched-but-otherwise-empty
lifecycle points (`session_end`, `user_prompt_submit`, `post_tool_failure`,
`post_tool_batch`, `subagent_start/stop`, `task_created/completed`,
`post_compact`). Each emits one structured log line and returns `{}`. This is
the documented baseline; swap the `BUILTIN_REGISTRARS` entry to attach richer
behaviour (Langfuse session emit, OTel span event, Slack notify). Not a gap.

Related: `tag-maturity` and `foundation-citation-guard` hooks are
informational-only today; assertion-time → retrieval-time maturity gating is
a tracked design item (`BACKLOG.md` `[agent-claw/maturity]`), not a stub.

---

## 4. Workspace-boundary helper — duplicate, not a missing caller

`services/agent-claw/src/security/workspace-boundary.ts`
(`assertWithinWorkspace`) and `services/agent-claw/src/tools/builtins/_fs_root.ts`
(`resolveAndCheckPath`) now both implement path-escape rejection. The fs
builtins (`read_file` / `write_file` / `edit_file` / `list_directory`) use
`_fs_root.ts`. The Phase-6 `assertWithinWorkspace` helper still has no
production caller — but the gap it was waiting on (filesystem-shaped tools)
closed via a parallel implementation. Action: converge the two onto one
helper, or delete `workspace-boundary.ts` if `_fs_root.ts` is the keeper.
Tracked in `BACKLOG.md` `[parity/security]`. Not blocking anything.

---

## 5. Already-resolved former placeholders (for reference)

These were flagged in earlier audits and are **done** — listed so a future
sweep doesn't re-open them:

- ChemBench eval scaffold no longer returns `{status:"placeholder",passed:False}`
  — collapses to `skipped` or a real `ok`/`below_target` decision
  (`services/optimizer/eval_chemistry/`).
- `mcp_instrument_template` promoted from a docs-only dir to a runnable skeleton.
- `corrections` table dropped (duplicate of `feedback_events.correction_payload`)
  — `db/init/52_drop_corrections.sql`.
- `redactor` 5 MB ceiling fails closed (`[REDACTED:OVERSIZE]`) instead of
  passing raw text through.
- All 16 lifecycle points have at least one registrar; boot refuses on a
  YAML-without-registrar.

---

## 6. Remediation plan — priority order

Per the 2026-05-12 scoping decision: blocked-external stubs stay as-is
(documented here); mock source systems stay mock but get hardened; work
through `BACKLOG.md` in tranches. Suggested ordering (each tranche = one
reviewed PR, smallest blast radius first):

1. **Docs / config hygiene** *(this PR)* — this inventory; `.env.example`
   coverage for `AGENT_FS_TOOLS_ENABLED` / `AGENT_FS_ROOT` /
   `AGENT_SHELL_ALLOWLIST` / `AGENT_SHELL_TIMEOUT_MS` /
   `AGENT_TURN_WALL_CLOCK_MS` (`BACKLOG.md` `[docs/.env.example]`).
2. **mypy clean-subset restoration** — `mcp_doc_fetcher` (~10 errs),
   `mcp_eln_local` (~11 errs), `ingestion/doc_ingester` (2 errs),
   `compound_classifier` + `compound_fingerprinter` (`psycopg.AsyncConnection`
   annotations). Mechanical; re-adds them to the CI clean list.
3. **Dead-code decisions** — `services/ingestion/eln_json_importer.legacy/**`
   (delete vs. re-enable); `services/mcp_tools/common/error_envelope.py` +
   `error_codes.py` (wire into `app.py` vs. drop). Pick one, do it.
4. **Test-coverage backfill** (no new infra needed): `mcp_yield_baseline`
   `_domain_dump↔_domain_load` round-trip, `combine_batch` length-mismatch,
   `reaction_optimizer` `used_bo=True` multi-objective, `dynamic_patterns.py`
   unbounded-quantifier scanner, `mcp_doc_fetcher/fetchers.py` socket-pin,
   `optimizer.ts` / `forged-tools.ts` route tests, projector-error tests
   (`compound_fingerprinter`).
5. **Test-coverage backfill** (needs a Postgres/Neo4j testcontainer — Docker
   in CI): projector replay parametrised over all projectors;
   `kg_source_cache` UUID-cast round-trip; concurrent `withUserContext`
   isolation; `recommend_next_batch` ON-CONFLICT race; `manage_plan`
   parallel-mutation; bi-temporal triple matrix; lifecycle-hook assertions.
6. **Security / robustness hardening**: `MCP_AUTH_SIGNING_KEY_NEXT` dual-key
   rotation; per-request retry budget via AsyncLocalStorage; circuit breaker
   in `mcp_tools/common/app`; `record_error_event` callers; `tool_log` SSE
   throttle; org/project threading through `PolicyMatchContext`.
7. **Config migration**: per-role inference params, reanimator knobs, and
   hardcoded route knobs → `config_settings`; one `feature_flags` consumer to
   prove that path; `redaction_patterns` org-context threading through
   LiteLLM.
8. **DB infrastructure** *(largest)*: replace lex-ordered `db/init/*.sql`
   with a real migration tool (Alembic / sqitch); canonical-table audit
   history; `schema_version` provenance reconciliation; native ENUMs for
   closed value sets.
9. **Chemistry-result persistence**: `compute_result_observed` ingestion
   event + canonical store for ASKCOS / AiZynth / Chemprop / SIRIUS /
   synthegy-mech outputs (or document loudly that prediction tools don't
   persist); `is_predicted` + `model_id` discriminator on `reactions`;
   chemprop calibrated `std` into `compute_confidence_ensemble`.
10. **Then, only with external prerequisites in hand**: g-xTB binary;
    REINVENT bundle; real LOGS tenant; doc-fetcher s3/smb/sharepoint
    providers; cross-project KGE / motif transfer (each needs its own ADR).

Everything in tranches 1–9 is in-repo. Tranche 10 items stay 501 /
`NotImplementedError` until the dependency lands and must not be replaced by
silent fallbacks.
