# BACKLOG

Deferred follow-ups discovered while doing other work. One bullet per item, prefixed with the area in brackets. Append-only; flat list. Don't write justifications — just enough text to rediscover the idea. See `CLAUDE.md` "General rules" #5.

- [ci/projectors] restore `compound_classifier` + `compound_fingerprinter` to the mypy clean subset (currently dropped in the per-package list with a note in `.github/workflows/ci.yml`); pay down the bare `psycopg.AsyncConnection` annotations
- [agent-claw/permissions] wire remaining 5 `runHarness` / `runChainedHarness` call sites with `{ permissionMode: 'enforce' }` — `chat.ts` is done; still missing: `routes/plan.ts`, `routes/deep-research.ts` (×2 sites), `routes/sessions-handlers.ts` (×2 sites)
- [redactor] org-scoped `redaction_patterns` rows are stored but not yet applied per-call — LiteLLM gateway needs a way to receive the caller's org context (custom HTTP header from agent-claw → callback)
- [tests/perf] `tests/unit/test_redactor.py::test_redact_skips_rxn_regex_when_arrows_absent` is a CPU-sensitive perf-threshold test that flakes locally and on CI under load — relax 0.5s threshold or move to a benchmark suite
- [agent-claw/skills] migrate `MAX_ACTIVE_SKILLS` (currently constant in `core/skills.ts:53`) to `config_settings` via `SkillLoader.refreshLimits()` — infra ready, just needs the call-site swap
- [agent-claw/llm] migrate per-role inference params (`temperature`, `max_tokens`, `top_p` for planner/executor/compactor/judge) to `config_settings` — needs threading user/project/org context through the `LlmProvider` interface to `litellm-provider.ts`
- [optimizer/gepa] migrate hardcoded promotion thresholds (`PROMOTION_SUCCESS_RATE=0.55`, `DEMOTION_SUCCESS_RATE=0.40`, `MIN_RUNS=30` in `services/optimizer/skill_promoter/promoter.py`) to `config_settings` via the Python `services.common.config_registry`
- [optimizer/reanimator] migrate stalled-definition knobs (`STALE_AFTER_SECONDS`, finish-reason allow-list) from env vars to `config_settings`
- [infra/backups] live end-to-end backup → restore drill in staging (requires real S3 bucket + age key) — `make backup.test-restore` script is in place, the secret + bucket are not
- [ci/workflows] adding tests for a new MCP service requires three CI edits (install reqs, pytest path, sometimes diff-cover exclude) — add a generator or `make ci.regenerate` that derives those from the on-disk service tree, or document the checklist
- [ci/security-hook] `.github/workflows/*.yml` Edit/Write is blocked by the security_reminder_hook even for safe edits — agents currently route around with Python `pathlib.write_text`. Either trust the hook for trusted authors or document the workaround
- [orphan-branches] `origin/claude/crib-workflow-engine-TBQ6a` and `origin/fix-pr-72` exist with no PR — investigate whether they're abandoned or in-progress, then delete or PR them
