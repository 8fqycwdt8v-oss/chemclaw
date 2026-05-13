# Contributing to ChemClaw

This guide covers the local-developer quality gates introduced by
PR-1 (`refactor/tooling`). The intent is "make `git commit` and CI
catch every issue locally before review", not "make committing
painful". Bypass for emergencies only with `--no-verify`.

## One-time setup

```bash
# Python venv + service deps (idempotent)
make setup

# Install pre-commit hooks (per-clone — runs on every git commit)
pip install pre-commit
pre-commit install
```

## What runs on every commit

`.pre-commit-config.yaml` wires the following hooks:

| Hook | What it checks |
|---|---|
| `end-of-file-fixer` | Files end with a single newline |
| `trailing-whitespace` | No trailing whitespace on lines |
| `check-yaml` / `check-json` | Valid YAML / JSON syntax (Helm templates excluded) |
| `check-added-large-files` | New file ≤ 1 MB |
| `check-merge-conflict` | No leftover `<<<<<<<` markers |
| `detect-private-key` | No `-----BEGIN PRIVATE KEY-----` blocks |
| `ruff` (`--fix`) | Python lint + auto-fixes |
| `ruff-format` | Python format |
| `mypy` | Strict type-check on the clean subset (`services/optimizer/session_purger`) |
| `eslint` (agent-claw) | TypeScript lint on staged TS files |
| `eslint` (paperclip) | TypeScript lint on staged TS files |
| `detect-secrets` | New high-entropy strings vs `.secrets.baseline` |

Run all hooks against the entire tree any time:

```bash
pre-commit run --all-files
```

Update the secrets baseline after intentionally adding a fixture token:

```bash
detect-secrets scan --update .secrets.baseline
git add .secrets.baseline
```

## What CI runs (must all pass)

- `make lint` — ruff + ESLint (warnings OK; errors fail)
- `make typecheck` — mypy (clean subset only) + TypeScript
- `make test` — pytest + vitest
- `make coverage` — emits lcov + coverage.xml for diff-cover
- `diff-cover` — changed-line coverage on every PR (see thresholds below)
- `npm audit --audit-level=high`

### Coverage thresholds

The `diff-cover` step fails if changed-line coverage falls below:

| Surface | Threshold | Reasoning |
|---|---:|---|
| `services/agent-claw/src/**` (excluding routes/, index.ts, config.ts) | 75% | Matches today's overall TS coverage |
| `services/agent-claw/src/routes/**` | 60% | Carve-out — route layer needs targeted PRs to lift |
| `services/**/*.py` (excluding NO-TESTS services) | 70% | Above today's combined Python rate |

The Python no-tests carve-out (excluded from diff-cover) covers
`session_reanimator`, `kg_hypotheses`, `mcp_drfp`, `mcp_rdkit`, and
`eln_json_importer.legacy`. As PR-N adds tests for each, the exclude
list shrinks. See
`docs/review/2026-04-29-codebase-audit/05-coverage-baseline.md` §8 for
the full rationale.

## Adding a new MCP / projector service to CI

`CLAUDE.md` covers the service-side scaffold (`create_app()`, Pydantic
validation, Dockerfile, `docker-compose.yml` entry). A new service's tests
don't run in CI until you also wire `.github/workflows/ci.yml` — there is no
generator yet, so this is the manual checklist (tracked as a `make
ci.regenerate` follow-up in `BACKLOG.md`):

1. **Install its deps** — add `python3 -m pip install -r
   services/<area>/<snake_name>/requirements.txt` to the Python job's install
   step (the block of `pip install -r …` lines around the top of the Python
   job). Order doesn't matter; keep it grouped with the other services.
2. **Run its tests** — add `services/<area>/<snake_name>/tests/` (or a
   specific `tests/test_*.py`) to the `coverage run … -m pytest` invocation's
   path list. If the test module mocks heavy imports at module scope and so
   can't be collected alongside the real package, point at the individual
   file(s) instead and leave a comment (see the `mcp_xtb` precedent).
3. **mypy clean subset (optional but expected)** — if the service is
   type-clean, add `mypy services/<area>/<snake_name>` to the mypy step. If it
   has known errors, add the line commented-out with a one-line note of the
   error count and file an item in `BACKLOG.md` to pay it down (see the
   `mcp_doc_fetcher` / `mcp_eln_local` precedents).
4. **diff-cover exclude (only if it ships without tests)** — if you genuinely
   can't add tests this PR, add
   `--exclude='services/<area>/<snake_name>/**'` to the Python `diff-cover`
   step and add a `[ci/diff-cover]` line to `BACKLOG.md` so the exclude gets
   removed when tests land. Don't do this to dodge writing tests — it's for
   modules whose main loop needs a testcontainer that isn't available yet.

Verify locally before pushing: `make test` (runs the same pytest path list)
and, if you touched the mypy step, `make typecheck`.

## Style notes

The ESLint configs in `services/agent-claw/eslint.config.mjs` and
`services/paperclip/eslint.config.mjs` extend
`@typescript-eslint/strict-type-checked` but downgrade most strict-type
rules from `error` to `warn` for PR-1 — the downgrade list is the
explicit `TODO(PR-4)` paydown queue. PR-4 (`refactor/typesafety`)
flips them back to `error` after the documented `any`-cast paydown.

The Ruff config in `pyproject.toml` follows the same pattern: rules
that fire today are listed in `tool.ruff.lint.ignore` with a `paydown
PR-N` comment. Pay them down individually; do not bulk-disable new
rules.

## Running a single test

```bash
# Python
.venv/bin/pytest tests/unit/test_redactor.py -v

# Single Python test case
.venv/bin/pytest tests/unit/test_redactor.py::test_redaction_is_deterministic -v

# TypeScript
npm run test --workspace services/agent-claw -- tests/unit/some.test.ts
```

## Worktree workflow (mandatory for non-trivial changes)

See `CLAUDE.md` for the full rationale. In short:

```bash
git worktree add ../chemclaw-<task> -b feature/<task>
# all edits in the worktree
# ...
# when done:
# (use the superpowers:finishing-a-development-branch skill)
```

The shared checkout is reserved for what the user is doing
interactively. If you skip the worktree and the parent's branch flips
under you, files vanish.
