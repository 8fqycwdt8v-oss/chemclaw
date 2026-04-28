# Remove Streamlit frontend; add minimal Python CLI

**Date:** 2026-04-27
**Status:** Approved (brainstorm); implementation pending
**Author:** Brainstorming session with the user
**Implementation track:** see companion plan in `docs/superpowers/plans/`

## Goal

Excise the Streamlit-based frontend (`services/frontend/`) and every
reference to it from the repository, and replace it for testing purposes
with a small Python CLI (`tools/cli/`, package `chemclaw_cli`, console
script `chemclaw`). The CLI wraps the existing `agent-claw` HTTP/SSE API
on port 3101. The future production frontend will be developed in a
separate git repository and is out of scope here.

## Non-goals

- Re-implementing the agent loop. `agent-claw` (TypeScript, port 3101)
  and `paperclip` (Node.js sidecar) stay exactly as they are. Their
  HTTP API is the contract a future frontend will consume.
- Building a CLI surface for every agent-claw route. Only `/api/chat` is
  wrapped. `/api/feedback`, `/api/eval`, `/api/forged-tools`,
  `/api/sessions/*` remain reachable via `curl`.
- Touching any MCP service, projector, the database schema, or the
  ingestion path.
- Producing a Docker image, homebrew formula, or any binary
  distribution for the CLI.
- Interactive REPL, multi-line input editor, or a `chemclaw login`
  flow. The CLI reads identity from an env var.

## Architectural choices (from brainstorm)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | What is "frontend"? | Streamlit only. Keep `agent-claw` and the FastAPI MCP services. | Q1 / Option A. Rebuilding the orchestrator in FastAPI would be a multi-week rewrite throwing away the v1.0.0-claw harness. |
| 2 | CLI scope | Chat only (`chemclaw chat ...`). | Q2 / Option A. Stopgap for testing; future frontend will replace it. |
| 3a | User identity | Env var `CHEMCLAW_USER` (default `dev@local.test`). | Q3a / Option i. Matches the convention `smoke.sh` already uses (`DEV_USER_ENTRA_ID`). |
| 3b | Session persistence | Per-user file `~/.chemclaw/last-session-<user>` for `--resume`. | Q3b / Option i. Doesn't cross streams when switching users; trivial to implement. |
| 4 | Framework + location | `typer` + `httpx` + `rich` at `tools/cli/`. | Q4 / Option A. `tools/` already houses dev/testing tooling (`e2e/`, `fake-litellm/`); `services/` is for deployable HTTP services. `typer` is the FastAPI-ecosystem choice (same author). |

## Removal scope

**Whole files / directories to delete:**
- `services/frontend/` (10 files — `streamlit_app.py`, `chat_client.py`,
  `chart_spec.py`, `db.py`, `settings.py`, `skill_client.py`,
  `pages/{chat,forged_tools,optimizer}.py`, `Dockerfile`,
  `requirements.txt`).
- `tests/unit/frontend/` (`test_chart_spec.py`, `test_chat_client.py`,
  `test_feedback_ui.py`, `test_optimizer_page.py`).
- `tests/unit/test_forged_tools_page.py` (the only frontend page test
  that lived outside the frontend tests dir).
- `infra/helm/values.yaml` lines 37-41 — the `frontend:` block.

**Files to edit:**
- `Makefile` — drop the `pip install -r services/frontend/requirements.txt`
  line in `setup` and the entire `run.frontend` target. Add
  `pip install -e tools/cli` to `setup`.
- `README.md` — replace `make run.frontend` with the CLI usage section.
- `.env.example` — drop `STREAMLIT_SERVER_PORT`, strip
  `:8501` URLs from `AGENT_CORS_ORIGINS`, update the comment that lists
  "frontend" as a user-facing service.
- `CLAUDE.md` — drop frontend mentions in the "Running individual
  services" list, the RLS table row, and the Python Streamlit
  `connect()` example. Add a one-line note that local testing now uses
  `chemclaw chat ...`.
- `AGENTS.md` — drop the chart-fence Streamlit-rendering paragraph
  (the agent still emits chart blocks; the future frontend will render
  them); drop the optimizer-page reference; rewrite SSE descriptions
  that say "the frontend" to say "the future frontend / any
  SSE-consuming client."
- `docs/runbooks/local-dev.md` — drop the frontend section.
- `docs/adr/001-architecture.md` — note the frontend has been removed
  pending a new repo.
- `docs/plans/clean-slate-audit.md`,
  `docs/plans/post-v1.0.0-hardening-round-3.md`,
  `docs/plans/mock-source-testbed.md` — sweep frontend references;
  mark as historical.
- `infra/helm/templates/core-deployments.yaml` — fix the comment that
  claims a frontend Deployment is included (no actual frontend
  Deployment object exists in the templates today).

**Explicitly not touched:**
- The `agent-claw` HTTP API surface — every route stays.
- All MCP services, projectors, paperclip, ingestion.
- The `chemclaw_app` DB role — still needed for agent-claw / paperclip
  traffic.
- Database schema, RLS policies, seeds.

## CLI design

### Layout

```
tools/cli/
├── pyproject.toml
├── README.md
├── chemclaw_cli/
│   ├── __init__.py        # __version__ = "0.1.0"
│   ├── __main__.py        # `python -m chemclaw_cli` shim
│   ├── app.py             # typer.Typer() + command registration
│   ├── config.py          # env reader: CHEMCLAW_USER, CHEMCLAW_AGENT_URL
│   ├── session_store.py   # ~/.chemclaw/last-session-<user>
│   ├── sse.py             # line-based SSE event parser (pure, no I/O)
│   └── commands/
│       ├── __init__.py
│       └── chat.py
└── tests/
    ├── __init__.py
    ├── conftest.py
    ├── test_sse.py
    ├── test_session_store.py
    └── test_chat.py
```

### Dependencies (`pyproject.toml`)

- `typer>=0.12,<1.0`
- `httpx>=0.27,<1.0`
- `rich>=13,<15`

Three deps, all stable. No optional `[all]` extras.

### Console script

```toml
[project.scripts]
chemclaw = "chemclaw_cli.app:app"
```

After `pip install -e tools/cli`, the user runs `chemclaw` from
anywhere inside the activated venv.

### Command surface

```
chemclaw chat "what is the yield of reaction X?"      # new session
chemclaw chat --resume "and side products?"           # continues last session for $CHEMCLAW_USER
chemclaw chat --session <id> "..."                    # continues a specific session (overrides --resume)
chemclaw chat --verbose "..."                         # also prints session events, todo updates, raw SSE on parse error
chemclaw --version                                    # prints version + exits
chemclaw --help                                       # typer auto-generated
```

### Config resolution

In order:
- `CHEMCLAW_AGENT_URL` env var → default `http://localhost:3101`.
- `CHEMCLAW_USER` env var → default `dev@local.test` (matches
  `smoke.sh`).

No CLI flags override these; the surface stays small.

### Request shape

```http
POST /api/chat HTTP/1.1
Host: localhost:3101
Content-Type: application/json
Accept: text/event-stream
x-user-entra-id: dev@local.test

{"messages":[{"role":"user","content":"..."}],"session_id":"<optional>"}
```

`session_id` is omitted for fresh sessions; included from the session
store on `--resume` or from the explicit `--session` flag.

### SSE event handling

The canonical event taxonomy is defined in
`services/agent-claw/src/streaming/sse.ts`. Wire format is always
`data: <json>\n\n` — single-line JSON, newlines pre-escaped server-side.

| Event `type` | Payload fields | CLI behavior | Exit code on stream end |
|---|---|---|---|
| `text_delta` | `delta: string` | Print `delta` to stdout, no newline, flush. | — |
| `session` | `session_id: string` | Write `session_id` to `~/.chemclaw/last-session-<user>`. Print only with `--verbose`. | — |
| `todo_update` | `todos: [{ ordering, content, status }]` | `--verbose` only: render the list, marking by status (`done` / `in_progress` / `pending`). | — |
| `awaiting_user_input` | `session_id: string; question: string` | Print `❓ <question>` (yellow); close stream. Also write `session_id` to the session store so a follow-up `--resume` works. | **2** |
| `tool_call` | `toolId: string; input: unknown` | `--verbose` only: compact `→ <toolId>(<truncated input>)`. | — |
| `tool_result` | `toolId: string; output: unknown` | `--verbose` only: compact `← <truncated output>`. | — |
| `plan_step` / `plan_ready` | (see sse.ts) | `--verbose` only: short summary line. | — |
| `error` | `error: string` | Print `error` (red); close stream. | **1** |
| `finish` | `finishReason: string; usage: {...}` | Print trailing newline; with `--verbose`, print `[dim]<finishReason> · <tokens>[/dim]`. | **0** |
| Unknown type | — | Ignored unless `--verbose`. | — |

### Error handling

| Failure | Behavior | Exit code |
|---|---|---|
| `httpx.ConnectError` | `agent-claw not reachable at <url>; is "make up" running?` | **3** |
| HTTP 401 / 403 | `auth rejected; check $CHEMCLAW_USER (currently "<value>")` | **4** |
| HTTP 5xx | First 500 chars of body. | **1** |
| `--resume` with no stored session | `no saved session for user "<value>" — start a new chat first` | **5** |
| `KeyboardInterrupt` mid-stream | Close connection; print `[interrupted]` (yellow). | **130** |
| Malformed SSE line | `--verbose` only: log to stderr; keep streaming. | — |

Distinct exit codes give shell scripts and CI something to branch on.

### Module sizes (target)

- `app.py` ≈ 15 LOC.
- `commands/chat.py` ≈ 70 LOC.
- `sse.py` ≈ 30 LOC.
- `session_store.py` ≈ 25 LOC.
- `config.py` ≈ 15 LOC.
- Total ≈ 155 LOC.

### Module boundaries

- `chat.py` is the only module that knows about HTTP.
- `sse.py` is pure parsing (no I/O); takes a byte iterator, yields
  dicts.
- `session_store.py` is pure filesystem; takes a user id, returns a
  path-bound reader/writer.
- `config.py` is pure env reading.

Each is independently testable.

## Testing

Tests under `tools/cli/tests/`. Mock HTTP via `httpx.MockTransport`
(no `respx` dep). Override the config dir to a `tmp_path` fixture so
session-store tests don't touch the real `~/.chemclaw`.

| Test | Asserts |
|---|---|
| `test_sse_parses_simple_event` | parser yields `{"type":"text_delta","delta":"hi"}` for `data: {"type":"text_delta","delta":"hi"}\n\n` |
| `test_sse_handles_multiline_data` | per spec, multiple `data:` lines join with `\n` |
| `test_sse_skips_keepalive_comments` | lines starting with `:` ignored |
| `test_session_store_roundtrip` | write then read returns the same id |
| `test_session_store_per_user_separation` | two users → two files, no cross-read |
| `test_session_store_missing_returns_none` | unknown user returns None |
| `test_chat_streams_text_deltas_to_stdout` | three `text_delta` events → stdout has concatenated text |
| `test_chat_writes_session_on_session_event` | session event lands in store |
| `test_chat_resume_sends_session_id` | `--resume` after prior call → POST body has session_id |
| `test_chat_resume_no_prior_exits_5` | clean store + `--resume` → exit 5 |
| `test_chat_awaiting_user_input_exits_2` | event triggers exit 2 |
| `test_chat_connect_error_exits_3` | mock raises ConnectError → exit 3 |
| `test_chat_http_401_exits_4` | mock returns 401 → exit 4 |
| `test_chat_sends_user_header` | POST request has `x-user-entra-id` from env |

Wire-up: extend root `pyproject.toml` `[tool.pytest.ini_options]`
testpaths to include `tools/cli/tests` (or rely on the existing
testpath if it already covers `tools/`).

## Makefile changes

```makefile
# In setup:
$(PIP) install -e tools/cli         # add this line
# remove:
$(PIP) install -r services/frontend/requirements.txt

# Remove the run.frontend target entirely.
# No replacement target — `chemclaw chat ...` is invoked directly.
```

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Agent-claw `/api/chat` schema changes silently | A request-body shape test in `test_chat.py` becomes the canary. |
| `~/.chemclaw/` written with overly permissive perms | Create dir with mode `0700`, files with `0600`. |
| User accidentally targets a non-localhost URL | Print the target URL on the first line of every chat invocation so it's visible in scrollback. |
| Future frontend (separate repo) needs the API contract | This spec records that `agent-claw` HTTP API is the contract; nothing in `services/agent-claw/` changes. |
| Removing tests reduces coverage of `chemclaw_app` RLS path | `agent-claw` test suite (667 tests) already covers the agent-side RLS context. Frontend tests were UI-shape tests; their loss is benign. |
| Helm `values.yaml` removal breaks dev clusters relying on it | Spec includes the helm change; the templates do not actually deploy a frontend Deployment, so removing the values block is metadata-only. |

## Out of scope (explicit YAGNI)

- CLI commands beyond `chat`.
- `chemclaw login` flow.
- Interactive REPL or multi-line input editor.
- Completion install (typer's built-in `--install-completion` is enough).
- Docker image for the CLI.
- Any change to `services/agent-claw/` source.
- Migrating tests from frontend to the CLI (frontend tests covered the
  Streamlit shape, not the contract; the CLI tests cover the contract
  fresh).

## Acceptance criteria

1. `services/frontend/` and `tests/unit/frontend/` no longer exist.
2. `tests/unit/test_forged_tools_page.py` no longer exists.
3. `infra/helm/values.yaml` has no `frontend:` block.
4. `grep -ri "streamlit" .` returns only historical mentions in
   `docs/plans/` and ADR (marked as removed).
5. `make setup` succeeds without trying to install Streamlit deps.
6. `make lint`, `make typecheck`, `make test` all green.
7. `chemclaw --version` prints a version.
8. `chemclaw chat --help` prints typer-generated help.
9. With `make up` running, `chemclaw chat "ping"` returns a streamed
   response from `agent-claw` (manual smoke).
10. `agent-claw` test count unchanged (667 passed).
