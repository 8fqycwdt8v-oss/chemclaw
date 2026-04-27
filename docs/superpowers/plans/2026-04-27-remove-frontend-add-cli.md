# Remove Streamlit frontend; add minimal Python CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Excise the Streamlit frontend and every reference to it; replace it with a small Python CLI (`tools/cli/`, package `chemclaw_cli`, console script `chemclaw`) that wraps the existing `agent-claw` `/api/chat` SSE endpoint.

**Architecture:** Build the CLI first so the project is never without a way to talk to the agent. Then delete the Streamlit code. Then sweep docs. The CLI is a thin SSE→stdout streamer with three pure modules (`sse`, `config`, `session_store`) plus one orchestration module (`commands/chat`).

**Tech Stack:** Python 3.11+, `typer>=0.12`, `httpx>=0.27`, `rich>=13`, `pytest`. Standard library only for the pure modules.

**Spec:** `docs/superpowers/specs/2026-04-27-remove-frontend-add-cli-design.md`

## Background a fresh engineer needs

- **Project layout:** monorepo with services in `services/`, dev tooling in `tools/`, tests in `tests/`. Each service is independently dep-managed (`requirements.txt` or `pyproject.toml`).
- **The agent backend** lives at `services/agent-claw/` (TypeScript, Fastify, SSE on port 3101). Its `/api/chat` route accepts `{messages, session_id?}` and emits `data: <single-line-json>\n\n` events.
- **Canonical SSE event types** are defined in `services/agent-claw/src/streaming/sse.ts`. Newlines in payload JSON are pre-escaped to `\\n` server-side, so each event is exactly one `data:` line followed by a blank line.
- **Identity / RLS:** every request to agent-claw must carry header `x-user-entra-id: <id>`. Agent-claw uses it to set Postgres `app.current_user_entra_id` for RLS.
- **`session_id`** must be a valid UUID — agent-claw `safeParse`s with `z.string().uuid()` and 400s otherwise.
- **Pytest config** lives in root `pyproject.toml` `[tool.pytest.ini_options]`; we extend `testpaths` to pick up the CLI tests.
- **Frequent commits:** one commit per task. Tests precede implementation. Short imperative subjects, body explains why.

---

## Phase 1 — Build the CLI

### Task 1: Scaffold the `tools/cli/` package

**Files:**
- Create: `tools/cli/pyproject.toml`
- Create: `tools/cli/README.md`
- Create: `tools/cli/chemclaw_cli/__init__.py`
- Create: `tools/cli/chemclaw_cli/__main__.py`
- Create: `tools/cli/chemclaw_cli/app.py`
- Create: `tools/cli/chemclaw_cli/commands/__init__.py`
- Create: `tools/cli/tests/__init__.py`
- Create: `tools/cli/tests/conftest.py`

- [ ] **Step 1.1: Create `tools/cli/pyproject.toml`**

```toml
[project]
name = "chemclaw-cli"
version = "0.1.0"
description = "Command-line client for the ChemClaw agent (agent-claw HTTP/SSE)"
requires-python = ">=3.11"
license = { text = "Apache-2.0" }
dependencies = [
    "typer>=0.12,<1.0",
    "httpx>=0.27,<1.0",
    "rich>=13,<15",
]

[project.scripts]
chemclaw = "chemclaw_cli.app:app"

[build-system]
requires = ["setuptools>=70"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["."]
include = ["chemclaw_cli*"]
exclude = ["tests*"]
```

- [ ] **Step 1.2: Create `tools/cli/README.md`**

```markdown
# chemclaw — minimal CLI for the ChemClaw agent

Wraps `agent-claw`'s `/api/chat` SSE endpoint. Replaces the Streamlit
frontend for local testing. The production frontend will live in a
separate repository.

## Install

From the repo root:

    pip install -e tools/cli

Or via `make setup`, which does the same thing.

## Use

Bring up the stack first:

    make up
    make run.agent

Then:

    chemclaw chat "what is the yield of reaction X?"
    chemclaw chat --resume "and side products?"
    chemclaw chat --session <uuid> "..."
    chemclaw chat --verbose "..."

## Configuration

| Env var               | Default                  | Purpose                                          |
|-----------------------|--------------------------|--------------------------------------------------|
| `CHEMCLAW_USER`       | `dev@local.test`         | Sent as `x-user-entra-id` for RLS                |
| `CHEMCLAW_AGENT_URL`  | `http://localhost:3101`  | Base URL of agent-claw                           |
| `CHEMCLAW_CONFIG_DIR` | `~/.chemclaw`            | Where the per-user last-session file is written  |

## Exit codes

| Code | Meaning                                     |
|------|---------------------------------------------|
| 0    | Stream finished normally (`finish` event)   |
| 1    | Server error (HTTP 5xx) or `error` event    |
| 2    | Agent paused with `awaiting_user_input`     |
| 3    | Could not connect to agent-claw             |
| 4    | Auth rejected (HTTP 401/403)                |
| 5    | `--resume` with no stored session for user  |
| 130  | KeyboardInterrupt                           |
```

- [ ] **Step 1.3: Create `tools/cli/chemclaw_cli/__init__.py`**

```python
"""chemclaw — minimal CLI for the ChemClaw agent."""

__version__ = "0.1.0"
```

- [ ] **Step 1.4: Create `tools/cli/chemclaw_cli/commands/__init__.py`**

```python
"""CLI subcommands for chemclaw."""
```

- [ ] **Step 1.5: Create `tools/cli/chemclaw_cli/__main__.py`**

```python
"""Entry point for `python -m chemclaw_cli`."""

from chemclaw_cli.app import app


if __name__ == "__main__":
    app()
```

- [ ] **Step 1.6: Create `tools/cli/chemclaw_cli/app.py`**

```python
"""Top-level Typer application."""

from __future__ import annotations

import typer

from chemclaw_cli import __version__

app = typer.Typer(
    name="chemclaw",
    help="Minimal CLI for the ChemClaw agent (agent-claw /api/chat).",
    no_args_is_help=True,
    add_completion=True,
)


def _version_callback(value: bool) -> None:
    if value:
        typer.echo(f"chemclaw {__version__}")
        raise typer.Exit(code=0)


@app.callback()
def _root(
    version: bool = typer.Option(
        False,
        "--version",
        callback=_version_callback,
        is_eager=True,
        help="Print version and exit.",
    ),
) -> None:
    """Root callback — exists to host --version."""
```

- [ ] **Step 1.7: Create `tools/cli/tests/__init__.py`**

```python
```

- [ ] **Step 1.8: Create `tools/cli/tests/conftest.py`**

```python
"""Shared pytest fixtures for the chemclaw_cli test suite.

Every test gets:
  - CHEMCLAW_CONFIG_DIR pointed at a tmp_path (no real ~/.chemclaw writes).
  - CHEMCLAW_USER and CHEMCLAW_AGENT_URL pinned to known test values, so
    tests do not pick up developer env state.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

import pytest


@pytest.fixture(autouse=True)
def _isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("CHEMCLAW_CONFIG_DIR", str(tmp_path / "chemclaw"))
    monkeypatch.setenv("CHEMCLAW_USER", "test@unit.local")
    monkeypatch.setenv("CHEMCLAW_AGENT_URL", "http://test.local:9999")
    yield
```

- [ ] **Step 1.9: Install the package and verify the entry point works**

```bash
pip install -e tools/cli
chemclaw --version
```

Expected stdout: `chemclaw 0.1.0`

```bash
chemclaw --help
```

Expected: typer-rendered help; no subcommands yet (chat command added in Task 5).

- [ ] **Step 1.10: Commit**

```bash
git add tools/cli/
git commit -m "feat(cli): scaffold tools/cli package + typer app + --version

Adds the package skeleton, console-script entry point, and a Typer
root callback. No subcommands yet — those land in subsequent tasks."
```

---

### Task 2: SSE event parser (`sse.py`) — TDD

**Files:**
- Test: `tools/cli/tests/test_sse.py`
- Create: `tools/cli/chemclaw_cli/sse.py`

The parser is pure: takes an iterable of decoded lines (one per `\n`), yields dicts (one per SSE event). No I/O.

Per the agent-claw wire format (`services/agent-claw/src/streaming/sse.ts`):
- Each event is `data: <single-line-json>` followed by a blank line.
- Newlines in payload JSON are pre-escaped to `\\n` server-side, so multi-line `data:` accumulation is rare but supported per SSE spec.
- Lines starting with `:` are SSE comments / keepalives — ignored.
- An empty line dispatches the accumulated event.

- [ ] **Step 2.1: Write the failing tests**

`tools/cli/tests/test_sse.py`:

```python
"""Tests for the line-based SSE parser."""

from __future__ import annotations

from chemclaw_cli.sse import parse_sse_lines


def test_parses_single_data_event() -> None:
    lines = [
        'data: {"type":"text_delta","delta":"hi"}',
        "",
    ]
    events = list(parse_sse_lines(iter(lines)))
    assert events == [{"type": "text_delta", "delta": "hi"}]


def test_parses_multiple_events() -> None:
    lines = [
        'data: {"type":"text_delta","delta":"a"}',
        "",
        'data: {"type":"text_delta","delta":"b"}',
        "",
        'data: {"type":"finish","finishReason":"stop","usage":{"promptTokens":1,"completionTokens":1}}',
        "",
    ]
    events = list(parse_sse_lines(iter(lines)))
    assert [e["type"] for e in events] == ["text_delta", "text_delta", "finish"]
    assert events[1]["delta"] == "b"


def test_handles_multiline_data_per_spec() -> None:
    """Per the SSE spec, multiple `data:` lines join with `\\n`."""
    lines = [
        "data: line one",
        "data: line two",
        "",
    ]
    events = list(parse_sse_lines(iter(lines), parse_json=False))
    assert events == ["line one\nline two"]


def test_skips_keepalive_comments() -> None:
    lines = [
        ": keepalive",
        'data: {"type":"text_delta","delta":"x"}',
        "",
    ]
    events = list(parse_sse_lines(iter(lines)))
    assert events == [{"type": "text_delta", "delta": "x"}]


def test_ignores_unknown_field_lines() -> None:
    """`event:` and `id:` are valid SSE fields but unused by agent-claw."""
    lines = [
        "event: ignored",
        "id: 42",
        'data: {"type":"text_delta","delta":"y"}',
        "",
    ]
    events = list(parse_sse_lines(iter(lines)))
    assert events == [{"type": "text_delta", "delta": "y"}]


def test_no_trailing_blank_yields_partial_event() -> None:
    """If the connection closes mid-event, the half-built event is dropped."""
    lines = ['data: {"type":"text_delta","delta":"partial"}']
    events = list(parse_sse_lines(iter(lines)))
    assert events == []


def test_invalid_json_raises_on_parse() -> None:
    """When parse_json=True (the default), bad JSON propagates as ValueError."""
    import pytest

    lines = ["data: not-json", ""]
    with pytest.raises(ValueError):
        list(parse_sse_lines(iter(lines)))


def test_data_with_no_space_after_colon_still_parses() -> None:
    """Per the SSE spec, the single space after the colon is optional."""
    lines = ['data:{"type":"text_delta","delta":"z"}', ""]
    events = list(parse_sse_lines(iter(lines)))
    assert events == [{"type": "text_delta", "delta": "z"}]
```

- [ ] **Step 2.2: Run the tests to verify they fail**

```bash
.venv/bin/pytest tools/cli/tests/test_sse.py -v
```

Expected: ImportError or ModuleNotFoundError on `chemclaw_cli.sse`.

- [ ] **Step 2.3: Implement `tools/cli/chemclaw_cli/sse.py`**

```python
"""Line-based Server-Sent Events parser.

Pure function: takes an iterable of already-decoded lines (no trailing
newlines), yields events. No I/O, no global state, no httpx coupling.

Conforms to the subset of the SSE spec that agent-claw emits:
  - Each event is one or more `data:` lines followed by a blank line.
  - Lines starting with `:` are comments and ignored.
  - All other field names (`event:`, `id:`, `retry:`) are accepted but
    not used.
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Iterator


def parse_sse_lines(
    lines: Iterable[str],
    *,
    parse_json: bool = True,
) -> Iterator[Any]:
    """Yield one event per blank-line-terminated SSE message.

    Args:
        lines: an iterable of decoded lines without trailing newlines.
        parse_json: when True (default), each event's data is run
            through `json.loads`. When False, the raw joined data string
            is yielded — useful for tests of the framing logic itself.

    Raises:
        ValueError: if `parse_json=True` and a data block is not valid JSON.
    """
    data_buf: list[str] = []
    for line in lines:
        if line == "":
            if data_buf:
                payload = "\n".join(data_buf)
                yield json.loads(payload) if parse_json else payload
                data_buf = []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            chunk = line[5:]
            if chunk.startswith(" "):
                chunk = chunk[1:]
            data_buf.append(chunk)
            continue
        # Other field lines (event:, id:, retry:) — agent-claw doesn't
        # use them, ignore silently.
```

- [ ] **Step 2.4: Run the tests to verify they pass**

```bash
.venv/bin/pytest tools/cli/tests/test_sse.py -v
```

Expected: 8 passed.

- [ ] **Step 2.5: Commit**

```bash
git add tools/cli/chemclaw_cli/sse.py tools/cli/tests/test_sse.py
git commit -m "feat(cli): SSE line parser

Pure parser: lines in, dicts out. Conforms to the subset of the SSE
spec that agent-claw emits (data:-only, blank-line-terminated)."
```

---

### Task 3: Config (`config.py`) — TDD

**Files:**
- Test: `tools/cli/tests/test_config.py`
- Create: `tools/cli/chemclaw_cli/config.py`

`config.py` reads three env vars with documented defaults. Pure I/O at
the env boundary; no filesystem writes.

- [ ] **Step 3.1: Write the failing tests**

`tools/cli/tests/test_config.py`:

```python
"""Tests for env-driven config."""

from __future__ import annotations

from pathlib import Path

import pytest

from chemclaw_cli.config import load_config


def test_returns_defaults_when_env_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    # The conftest sets these — clear them here to test true defaults.
    monkeypatch.delenv("CHEMCLAW_USER", raising=False)
    monkeypatch.delenv("CHEMCLAW_AGENT_URL", raising=False)
    monkeypatch.delenv("CHEMCLAW_CONFIG_DIR", raising=False)
    cfg = load_config()
    assert cfg.user == "dev@local.test"
    assert cfg.agent_url == "http://localhost:3101"
    assert cfg.config_dir == Path.home() / ".chemclaw"


def test_picks_up_env_overrides(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("CHEMCLAW_USER", "alice@corp.test")
    monkeypatch.setenv("CHEMCLAW_AGENT_URL", "https://agent.staging:443")
    monkeypatch.setenv("CHEMCLAW_CONFIG_DIR", str(tmp_path))
    cfg = load_config()
    assert cfg.user == "alice@corp.test"
    assert cfg.agent_url == "https://agent.staging:443"
    assert cfg.config_dir == tmp_path


def test_strips_trailing_slash_from_agent_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHEMCLAW_AGENT_URL", "http://localhost:3101/")
    cfg = load_config()
    assert cfg.agent_url == "http://localhost:3101"
```

- [ ] **Step 3.2: Run tests to verify they fail**

```bash
.venv/bin/pytest tools/cli/tests/test_config.py -v
```

Expected: ModuleNotFoundError on `chemclaw_cli.config`.

- [ ] **Step 3.3: Implement `tools/cli/chemclaw_cli/config.py`**

```python
"""Env-driven configuration for the chemclaw CLI."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_USER = "dev@local.test"
DEFAULT_AGENT_URL = "http://localhost:3101"
DEFAULT_CONFIG_DIRNAME = ".chemclaw"


@dataclass(frozen=True)
class Config:
    user: str
    agent_url: str
    config_dir: Path


def load_config() -> Config:
    """Read CHEMCLAW_* env vars with documented defaults."""
    user = os.environ.get("CHEMCLAW_USER", DEFAULT_USER)
    agent_url = os.environ.get("CHEMCLAW_AGENT_URL", DEFAULT_AGENT_URL).rstrip("/")
    config_dir_env = os.environ.get("CHEMCLAW_CONFIG_DIR")
    config_dir = Path(config_dir_env) if config_dir_env else Path.home() / DEFAULT_CONFIG_DIRNAME
    return Config(user=user, agent_url=agent_url, config_dir=config_dir)
```

- [ ] **Step 3.4: Run tests to verify they pass**

```bash
.venv/bin/pytest tools/cli/tests/test_config.py -v
```

Expected: 3 passed.

- [ ] **Step 3.5: Commit**

```bash
git add tools/cli/chemclaw_cli/config.py tools/cli/tests/test_config.py
git commit -m "feat(cli): env-driven config (CHEMCLAW_USER, CHEMCLAW_AGENT_URL, CHEMCLAW_CONFIG_DIR)"
```

---

### Task 4: Session store (`session_store.py`) — TDD

**Files:**
- Test: `tools/cli/tests/test_session_store.py`
- Create: `tools/cli/chemclaw_cli/session_store.py`

Per the spec, the store keeps one file per user, named
`last-session-<safe_user>` where `safe_user` is the user id with
non-alphanumerics replaced by `_`. Dir mode `0o700`, file mode `0o600`.

- [ ] **Step 4.1: Write the failing tests**

`tools/cli/tests/test_session_store.py`:

```python
"""Tests for the per-user last-session file store."""

from __future__ import annotations

from pathlib import Path

import pytest

from chemclaw_cli.session_store import SessionStore


@pytest.fixture
def store(tmp_path: Path) -> SessionStore:
    return SessionStore(config_dir=tmp_path / "chemclaw")


def test_read_returns_none_when_no_file(store: SessionStore) -> None:
    assert store.read("alice@corp") is None


def test_write_then_read_roundtrip(store: SessionStore) -> None:
    store.write("alice@corp", "11111111-1111-1111-1111-111111111111")
    assert store.read("alice@corp") == "11111111-1111-1111-1111-111111111111"


def test_per_user_separation(store: SessionStore) -> None:
    store.write("alice@corp", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    store.write("bob@corp", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
    assert store.read("alice@corp").startswith("aaaa")
    assert store.read("bob@corp").startswith("bbbb")


def test_overwrite(store: SessionStore) -> None:
    store.write("alice@corp", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    store.write("alice@corp", "cccccccc-cccc-cccc-cccc-cccccccccccc")
    assert store.read("alice@corp").startswith("cccc")


def test_user_id_with_special_chars_does_not_traverse(store: SessionStore) -> None:
    """Non-alphanumeric characters must be sanitised to prevent
    accidental path traversal or filename collisions."""
    store.write("../../../etc/passwd", "abcd1234-abcd-1234-abcd-123412341234")
    assert store.read("../../../etc/passwd") == "abcd1234-abcd-1234-abcd-123412341234"
    # The stored file lives under the config dir, never above it.
    files = list(store.config_dir.rglob("*"))
    assert all(store.config_dir in f.parents or f == store.config_dir for f in files)


def test_dir_and_file_perms_are_owner_only(store: SessionStore) -> None:
    """Defense in depth: ~/.chemclaw is created 0o700, files 0o600."""
    store.write("alice@corp", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    dir_mode = store.config_dir.stat().st_mode & 0o777
    file_path = next(store.config_dir.glob("last-session-*"))
    file_mode = file_path.stat().st_mode & 0o777
    assert dir_mode == 0o700
    assert file_mode == 0o600
```

- [ ] **Step 4.2: Run tests to verify they fail**

```bash
.venv/bin/pytest tools/cli/tests/test_session_store.py -v
```

Expected: ModuleNotFoundError on `chemclaw_cli.session_store`.

- [ ] **Step 4.3: Implement `tools/cli/chemclaw_cli/session_store.py`**

```python
"""Per-user last-session-id file store.

One small file per user under `~/.chemclaw/`. The file holds a UUID
(the agent-claw session_id) and nothing else. Used by `chemclaw chat
--resume` to look up the most recent session for the current user.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

_SAFE = re.compile(r"[^a-zA-Z0-9]+")


def _safe_user(user_id: str) -> str:
    return _SAFE.sub("_", user_id).strip("_") or "anon"


@dataclass(frozen=True)
class SessionStore:
    config_dir: Path

    def _path(self, user_id: str) -> Path:
        return self.config_dir / f"last-session-{_safe_user(user_id)}"

    def read(self, user_id: str) -> str | None:
        path = self._path(user_id)
        if not path.exists():
            return None
        return path.read_text(encoding="utf-8").strip() or None

    def write(self, user_id: str, session_id: str) -> None:
        self.config_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        # mkdir won't reset perms on an existing dir; do it explicitly.
        self.config_dir.chmod(0o700)
        path = self._path(user_id)
        path.write_text(session_id, encoding="utf-8")
        path.chmod(0o600)
```

- [ ] **Step 4.4: Run tests to verify they pass**

```bash
.venv/bin/pytest tools/cli/tests/test_session_store.py -v
```

Expected: 6 passed.

- [ ] **Step 4.5: Commit**

```bash
git add tools/cli/chemclaw_cli/session_store.py tools/cli/tests/test_session_store.py
git commit -m "feat(cli): per-user last-session file store

Owner-only perms (0700 dir / 0600 file). User ids are sanitised so a
hostile id can't escape the config dir."
```

---

### Task 5: Chat command (`commands/chat.py`) — TDD

**Files:**
- Test: `tools/cli/tests/test_chat.py`
- Create: `tools/cli/chemclaw_cli/commands/chat.py`
- Modify: `tools/cli/chemclaw_cli/app.py` (register the command)

This is the orchestration layer: HTTP + dispatch loop. Mock HTTP via
`httpx.MockTransport`. Use Typer's `CliRunner` (from `typer.testing`)
to drive the command.

Exit codes (from spec): 0 normal, 1 server error, 2 awaiting_user_input,
3 connect error, 4 auth rejected, 5 no stored session for --resume.

- [ ] **Step 5.1: Write the failing tests**

`tools/cli/tests/test_chat.py`:

```python
"""Tests for `chemclaw chat`."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

import httpx
import pytest
from typer.testing import CliRunner

from chemclaw_cli.app import app
from chemclaw_cli.session_store import SessionStore


def _sse_response(events: list[dict], status_code: int = 200) -> httpx.Response:
    """Build an SSE-shaped Response from a list of event dicts."""
    body = "".join(f"data: {json.dumps(e)}\n\n" for e in events).encode()
    return httpx.Response(
        status_code=status_code,
        headers={"content-type": "text/event-stream"},
        content=body,
    )


def _patch_transport(monkeypatch: pytest.MonkeyPatch, handler: Callable[[httpx.Request], httpx.Response]) -> list[httpx.Request]:
    """Replace httpx.Client with one that uses MockTransport(handler).

    Returns a list that captures every request made — tests can then
    assert on headers / bodies after running the command.
    """
    captured: list[httpx.Request] = []

    def _capturing_handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return handler(request)

    transport = httpx.MockTransport(_capturing_handler)
    real_client = httpx.Client

    def _factory(*args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", _factory)
    return captured


def test_streams_text_deltas_to_stdout(monkeypatch: pytest.MonkeyPatch) -> None:
    events = [
        {"type": "text_delta", "delta": "hello "},
        {"type": "text_delta", "delta": "world"},
        {"type": "finish", "finishReason": "stop", "usage": {"promptTokens": 1, "completionTokens": 2}},
    ]
    _patch_transport(monkeypatch, lambda req: _sse_response(events))

    result = CliRunner().invoke(app, ["chat", "hi"])
    assert result.exit_code == 0
    assert "hello world" in result.stdout


def test_sends_user_header_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHEMCLAW_USER", "alice@corp.test")
    captured = _patch_transport(
        monkeypatch,
        lambda req: _sse_response([{"type": "finish", "finishReason": "stop", "usage": {"promptTokens": 0, "completionTokens": 0}}]),
    )

    result = CliRunner().invoke(app, ["chat", "hi"])
    assert result.exit_code == 0
    assert captured[0].headers["x-user-entra-id"] == "alice@corp.test"


def test_sends_messages_array_and_no_session_on_fresh(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _patch_transport(
        monkeypatch,
        lambda req: _sse_response([{"type": "finish", "finishReason": "stop", "usage": {"promptTokens": 0, "completionTokens": 0}}]),
    )

    CliRunner().invoke(app, ["chat", "hello"])
    body = json.loads(captured[0].content.decode())
    assert body["messages"] == [{"role": "user", "content": "hello"}]
    assert "session_id" not in body or body.get("session_id") is None


def test_writes_session_id_on_session_event(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("CHEMCLAW_CONFIG_DIR", str(tmp_path / "chemclaw"))
    monkeypatch.setenv("CHEMCLAW_USER", "alice@corp.test")
    sid = "11111111-1111-1111-1111-111111111111"
    events = [
        {"type": "session", "session_id": sid},
        {"type": "text_delta", "delta": "hi"},
        {"type": "finish", "finishReason": "stop", "usage": {"promptTokens": 0, "completionTokens": 0}},
    ]
    _patch_transport(monkeypatch, lambda req: _sse_response(events))

    result = CliRunner().invoke(app, ["chat", "hello"])
    assert result.exit_code == 0
    assert SessionStore(tmp_path / "chemclaw").read("alice@corp.test") == sid


def test_resume_sends_stored_session_id(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("CHEMCLAW_CONFIG_DIR", str(tmp_path / "chemclaw"))
    monkeypatch.setenv("CHEMCLAW_USER", "alice@corp.test")
    sid = "22222222-2222-2222-2222-222222222222"
    SessionStore(tmp_path / "chemclaw").write("alice@corp.test", sid)
    captured = _patch_transport(
        monkeypatch,
        lambda req: _sse_response([{"type": "finish", "finishReason": "stop", "usage": {"promptTokens": 0, "completionTokens": 0}}]),
    )

    result = CliRunner().invoke(app, ["chat", "--resume", "follow up"])
    assert result.exit_code == 0
    body = json.loads(captured[0].content.decode())
    assert body["session_id"] == sid


def test_resume_with_no_stored_session_exits_5(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("CHEMCLAW_CONFIG_DIR", str(tmp_path / "chemclaw"))
    monkeypatch.setenv("CHEMCLAW_USER", "noone@corp.test")
    # No transport patched — should exit before any HTTP call.
    result = CliRunner().invoke(app, ["chat", "--resume", "x"])
    assert result.exit_code == 5
    assert "no saved session" in result.stdout.lower() or "no saved session" in (result.stderr or "").lower()


def test_explicit_session_flag_overrides_resume(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("CHEMCLAW_CONFIG_DIR", str(tmp_path / "chemclaw"))
    monkeypatch.setenv("CHEMCLAW_USER", "alice@corp.test")
    SessionStore(tmp_path / "chemclaw").write("alice@corp.test", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    captured = _patch_transport(
        monkeypatch,
        lambda req: _sse_response([{"type": "finish", "finishReason": "stop", "usage": {"promptTokens": 0, "completionTokens": 0}}]),
    )

    explicit = "33333333-3333-3333-3333-333333333333"
    result = CliRunner().invoke(app, ["chat", "--resume", "--session", explicit, "x"])
    assert result.exit_code == 0
    body = json.loads(captured[0].content.decode())
    assert body["session_id"] == explicit


def test_awaiting_user_input_exits_2(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("CHEMCLAW_CONFIG_DIR", str(tmp_path / "chemclaw"))
    monkeypatch.setenv("CHEMCLAW_USER", "alice@corp.test")
    sid = "44444444-4444-4444-4444-444444444444"
    events = [
        {"type": "session", "session_id": sid},
        {"type": "awaiting_user_input", "session_id": sid, "question": "Which solvent?"},
    ]
    _patch_transport(monkeypatch, lambda req: _sse_response(events))

    result = CliRunner().invoke(app, ["chat", "ambiguous"])
    assert result.exit_code == 2
    assert "Which solvent?" in result.stdout
    # The session_id must still be stored so a follow-up --resume works.
    assert SessionStore(tmp_path / "chemclaw").read("alice@corp.test") == sid


def test_error_event_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    events = [{"type": "error", "error": "model timeout"}]
    _patch_transport(monkeypatch, lambda req: _sse_response(events))

    result = CliRunner().invoke(app, ["chat", "boom"])
    assert result.exit_code == 1
    assert "model timeout" in result.stdout


def test_connect_error_exits_3(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nope")

    _patch_transport(monkeypatch, _raise)

    result = CliRunner().invoke(app, ["chat", "x"])
    assert result.exit_code == 3
    assert "not reachable" in result.stdout.lower()


def test_http_401_exits_4(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_transport(monkeypatch, lambda req: httpx.Response(status_code=401, content=b"nope"))

    result = CliRunner().invoke(app, ["chat", "x"])
    assert result.exit_code == 4
    assert "auth" in result.stdout.lower()


def test_http_500_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_transport(monkeypatch, lambda req: httpx.Response(status_code=500, content=b"server boom"))

    result = CliRunner().invoke(app, ["chat", "x"])
    assert result.exit_code == 1
    assert "server boom" in result.stdout
```

- [ ] **Step 5.2: Run tests to verify they fail**

```bash
.venv/bin/pytest tools/cli/tests/test_chat.py -v
```

Expected: ModuleNotFoundError on `chemclaw_cli.commands.chat`.

- [ ] **Step 5.3: Implement `tools/cli/chemclaw_cli/commands/chat.py`**

```python
"""`chemclaw chat` — single-shot streamed chat against agent-claw."""

from __future__ import annotations

import json
from typing import Optional

import httpx
import typer
from rich.console import Console

from chemclaw_cli.config import load_config
from chemclaw_cli.session_store import SessionStore
from chemclaw_cli.sse import parse_sse_lines

# Exit codes (also documented in tools/cli/README.md).
EXIT_OK = 0
EXIT_SERVER_ERROR = 1
EXIT_AWAITING_INPUT = 2
EXIT_CONNECT_ERROR = 3
EXIT_AUTH_REJECTED = 4
EXIT_RESUME_NO_SESSION = 5

_stderr = Console(stderr=True)
_stdout = Console()


def chat(
    prompt: str = typer.Argument(..., help="The user message to send."),
    resume: bool = typer.Option(False, "--resume", "-r", help="Continue the most recent session for $CHEMCLAW_USER."),
    session: Optional[str] = typer.Option(None, "--session", "-s", help="Continue a specific session UUID. Overrides --resume."),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show session, todo, tool, plan events too."),
) -> None:
    """Send a single user message; stream the agent's response."""
    cfg = load_config()
    store = SessionStore(config_dir=cfg.config_dir)

    session_id: Optional[str] = session
    if session_id is None and resume:
        session_id = store.read(cfg.user)
        if session_id is None:
            _stdout.print(f'no saved session for user "{cfg.user}" — start a new chat first')
            raise typer.Exit(code=EXIT_RESUME_NO_SESSION)

    body: dict = {"messages": [{"role": "user", "content": prompt}]}
    if session_id is not None:
        body["session_id"] = session_id

    headers = {
        "content-type": "application/json",
        "accept": "text/event-stream",
        "x-user-entra-id": cfg.user,
    }
    url = f"{cfg.agent_url}/api/chat"

    if verbose:
        _stderr.print(f"[dim]→ POST {url} (user={cfg.user})[/dim]")

    try:
        with httpx.Client(timeout=httpx.Timeout(connect=10.0, read=None, write=10.0, pool=10.0)) as client:
            with client.stream("POST", url, json=body, headers=headers) as response:
                if response.status_code in (401, 403):
                    response.read()
                    _stdout.print(f'auth rejected; check $CHEMCLAW_USER (currently "{cfg.user}")')
                    raise typer.Exit(code=EXIT_AUTH_REJECTED)
                if response.status_code >= 400:
                    response.read()
                    snippet = response.text[:500]
                    _stdout.print(snippet)
                    raise typer.Exit(code=EXIT_SERVER_ERROR)

                exit_code = _consume_stream(response, store=store, user=cfg.user, verbose=verbose)
                raise typer.Exit(code=exit_code)
    except httpx.ConnectError:
        _stdout.print(f'agent-claw not reachable at {cfg.agent_url}; is "make up" running?')
        raise typer.Exit(code=EXIT_CONNECT_ERROR) from None
    except KeyboardInterrupt:
        _stdout.print("[yellow][interrupted][/yellow]")
        raise typer.Exit(code=130) from None


def _consume_stream(
    response: httpx.Response,
    *,
    store: SessionStore,
    user: str,
    verbose: bool,
) -> int:
    """Drive the SSE loop. Returns the exit code to use."""
    exit_code = EXIT_OK
    saw_text = False

    for event in parse_sse_lines(response.iter_lines()):
        if not isinstance(event, dict):
            continue
        etype = event.get("type")

        if etype == "text_delta":
            delta = event.get("delta", "")
            _stdout.print(delta, end="", soft_wrap=True, markup=False, highlight=False)
            saw_text = True
            continue

        if etype == "session":
            sid = event.get("session_id")
            if sid:
                store.write(user, sid)
            if verbose:
                _stderr.print(f"[dim]session: {sid}[/dim]")
            continue

        if etype == "awaiting_user_input":
            sid = event.get("session_id")
            if sid:
                store.write(user, sid)
            question = event.get("question", "")
            if saw_text:
                _stdout.print()
            _stdout.print(f"[yellow]❓ {question}[/yellow]")
            return EXIT_AWAITING_INPUT

        if etype == "error":
            err = event.get("error", "<unknown error>")
            if saw_text:
                _stdout.print()
            _stdout.print(f"[red]{err}[/red]")
            return EXIT_SERVER_ERROR

        if etype == "finish":
            if saw_text:
                _stdout.print()
            if verbose:
                reason = event.get("finishReason", "?")
                usage = event.get("usage", {})
                _stderr.print(f"[dim]{reason} · {usage}[/dim]")
            return EXIT_OK

        if verbose:
            if etype == "todo_update":
                for todo in event.get("todos", []):
                    mark = {"done": "✓", "in_progress": "•", "pending": " "}.get(todo.get("status", ""), "?")
                    _stderr.print(f"[dim]{mark} {todo.get('content', '')}[/dim]")
            elif etype == "tool_call":
                _stderr.print(f"[dim]→ {event.get('toolId')}({_truncate(event.get('input'))})[/dim]")
            elif etype == "tool_result":
                _stderr.print(f"[dim]← {_truncate(event.get('output'))}[/dim]")
            elif etype in ("plan_step", "plan_ready"):
                _stderr.print(f"[dim]plan: {etype}[/dim]")
            else:
                _stderr.print(f"[dim]?? {etype}[/dim]")

    # Stream ended without `finish`. Treat as success — the connection
    # may have closed cleanly mid-emit on a fast small reply.
    if saw_text:
        _stdout.print()
    return exit_code


def _truncate(value: object, limit: int = 120) -> str:
    s = json.dumps(value, default=str) if not isinstance(value, str) else value
    return s if len(s) <= limit else s[: limit - 1] + "…"
```

- [ ] **Step 5.4: Register the command in `tools/cli/chemclaw_cli/app.py`**

Replace the entire file with:

```python
"""Top-level Typer application."""

from __future__ import annotations

import typer

from chemclaw_cli import __version__
from chemclaw_cli.commands.chat import chat as chat_command

app = typer.Typer(
    name="chemclaw",
    help="Minimal CLI for the ChemClaw agent (agent-claw /api/chat).",
    no_args_is_help=True,
    add_completion=True,
)

app.command("chat")(chat_command)


def _version_callback(value: bool) -> None:
    if value:
        typer.echo(f"chemclaw {__version__}")
        raise typer.Exit(code=0)


@app.callback()
def _root(
    version: bool = typer.Option(
        False,
        "--version",
        callback=_version_callback,
        is_eager=True,
        help="Print version and exit.",
    ),
) -> None:
    """Root callback — exists to host --version."""
```

- [ ] **Step 5.5: Run all CLI tests to verify they pass**

```bash
.venv/bin/pytest tools/cli/tests/ -v
```

Expected: all tests pass (8 sse + 3 config + 6 session_store + 12 chat = 29 passed).

- [ ] **Step 5.6: Smoke-check the help output**

```bash
chemclaw chat --help
```

Expected: typer-rendered help showing `prompt` argument and `--resume`, `--session`, `--verbose` options.

- [ ] **Step 5.7: Commit**

```bash
git add tools/cli/chemclaw_cli/commands/chat.py tools/cli/chemclaw_cli/app.py tools/cli/tests/test_chat.py
git commit -m "feat(cli): chemclaw chat — stream agent-claw /api/chat over SSE

Single-shot user message in, streamed agent reply out. --resume reads
the per-user last-session file; --session overrides. Distinct exit
codes for connect, auth, server, awaiting-input, and resume-empty
failure modes."
```

---

### Task 6: Wire pytest + Makefile

**Files:**
- Modify: `pyproject.toml` (extend pytest testpaths)
- Modify: `Makefile` (add `pip install -e tools/cli`; remove the frontend pip line + run.frontend target)

- [ ] **Step 6.1: Extend `[tool.pytest.ini_options]` in root `pyproject.toml`**

Find the existing block (around line 55):

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"
addopts = "-ra --strict-markers"
```

Change `testpaths` to:

```toml
testpaths = ["tests", "tools/cli/tests"]
```

- [ ] **Step 6.2: Update `Makefile` `setup.python` target**

Find `setup.python` (lines 27-41 currently). Apply two edits:

1. **Remove** the line:
   ```makefile
   $(PIP) install -r services/frontend/requirements.txt
   ```

2. **Add** this line just after `$(PIP) install -e ".[dev]"`:
   ```makefile
   $(PIP) install -e tools/cli
   ```

- [ ] **Step 6.3: Remove the `run.frontend` target entirely**

Delete lines 117-119 of the Makefile:

```makefile
.PHONY: run.frontend
run.frontend: ## Run Streamlit frontend
	$(VENV)/bin/streamlit run services/frontend/streamlit_app.py
```

(Do not add a replacement — `chemclaw chat ...` is invoked directly, not through `make`.)

- [ ] **Step 6.4: Verify the test suite still passes from the project root**

```bash
.venv/bin/pytest -q
```

Expected: existing tests + 29 new CLI tests, all passing. (Numbers may differ if frontend tests are still present — they will be removed in Phase 2.)

- [ ] **Step 6.5: Commit**

```bash
git add pyproject.toml Makefile
git commit -m "build: wire CLI into pytest testpaths + Makefile setup

Adds tools/cli/tests to pytest discovery and pip-installs the CLI
package as part of make setup. Drops the Streamlit frontend
requirements install and the run.frontend target."
```

---

## Phase 2 — Delete the Streamlit frontend

### Task 7: Delete `services/frontend/`

**Files:**
- Delete: `services/frontend/` (entire directory)

- [ ] **Step 7.1: Confirm nothing outside the planned removal scope still imports the frontend**

```bash
grep -rn "services\.frontend\|services/frontend\|streamlit" --include="*.py" --include="*.ts" --include="*.yaml" --include="*.yml" --include="Makefile" --include="Dockerfile*" . | grep -v "^docs/\|^node_modules/\|^\.venv/\|services/frontend/\|tests/unit/frontend/\|tests/unit/test_forged_tools_page" | head -20
```

Expected: only the AGENTS.md / CLAUDE.md / README.md / .env.example / infra/helm references that Phase 3 will rewrite. If anything else shows up, stop and add a task before continuing.

- [ ] **Step 7.2: Remove the directory**

```bash
git rm -r services/frontend
```

- [ ] **Step 7.3: Verify the venv still installs cleanly without Streamlit**

```bash
rm -rf .venv && make setup.python
```

Expected: `Python env ready.` printed; no error referencing `services/frontend/requirements.txt` (that line was removed in Task 6).

- [ ] **Step 7.4: Commit**

```bash
git add -A services/frontend
git commit -m "chore: remove services/frontend (Streamlit app)

The Streamlit frontend is being moved to a separate repository.
Local testing now goes through tools/cli/ (chemclaw chat ...).
The agent-claw HTTP/SSE API on port 3101 stays exactly as it was."
```

---

### Task 8: Delete frontend tests

**Files:**
- Delete: `tests/unit/frontend/` (entire directory)
- Delete: `tests/unit/test_forged_tools_page.py`

- [ ] **Step 8.1: Remove the frontend tests dir**

```bash
git rm -r tests/unit/frontend
git rm tests/unit/test_forged_tools_page.py
```

- [ ] **Step 8.2: Verify the test suite runs cleanly**

```bash
.venv/bin/pytest -q
```

Expected: all remaining tests pass; collection no longer mentions `tests/unit/frontend/` or `test_forged_tools_page`.

- [ ] **Step 8.3: Commit**

```bash
git commit -m "test: remove frontend page/UI tests

These covered Streamlit-specific shape (chart fences, chat client
session state, optimizer page render). The agent-claw test suite
already covers the contract those pages relied on."
```

---

### Task 9: Remove the `frontend:` block from helm values

**Files:**
- Modify: `infra/helm/values.yaml`

- [ ] **Step 9.1: Read the current block**

```bash
sed -n '35,45p' infra/helm/values.yaml
```

Expected output (lines 36-41):
```yaml

frontend:
  enabled: true
  image: chemclaw/frontend:latest
  port: 8501
  replicas: 1
```

- [ ] **Step 9.2: Delete lines 37-41 (the `frontend:` block; keep the leading blank line at 36 or also drop it for tidiness)**

Use `Edit`:

```yaml
# OLD:
<the entire frontend: block including the preceding blank line>

# NEW:
<nothing — drop both>
```

After editing, `git diff infra/helm/values.yaml` should show only the deletion of those 5-6 lines.

- [ ] **Step 9.3: Commit**

```bash
git add infra/helm/values.yaml
git commit -m "chore(helm): remove frontend values block

No corresponding Deployment object existed in the templates, so this
is metadata-only — but it stops new clusters from being mis-configured
as if a frontend image were on the way."
```

---

### Task 10: Fix the misleading comment in `core-deployments.yaml`

**Files:**
- Modify: `infra/helm/templates/core-deployments.yaml`

- [ ] **Step 10.1: Edit the comment**

Open `infra/helm/templates/core-deployments.yaml`. Lines 1-4 currently:

```yaml
# Core deployments — always deployed regardless of profile flags.
# Includes: agent-claw, paperclip-lite, frontend, litellm, litellm-redactor,
# and always-on projectors.
```

Change to:

```yaml
# Core deployments — always deployed regardless of profile flags.
# Includes: agent-claw, paperclip-lite, litellm, litellm-redactor,
# and always-on projectors.
```

(Drop `frontend, ` from the includes list.)

- [ ] **Step 10.2: Commit**

```bash
git add infra/helm/templates/core-deployments.yaml
git commit -m "docs(helm): drop 'frontend' from the core-deployments comment"
```

---

### Task 11: Clean `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 11.1: Apply three edits**

a) Line 17 currently reads:
```
# Used by user-facing services (agent-claw, frontend, paperclip).
```
Change to:
```
# Used by user-facing services (agent-claw, paperclip).
```

b) Line 38 currently reads:
```
AGENT_CORS_ORIGINS=http://localhost:8501,http://127.0.0.1:8501
```
Change to:
```
# CORS origins for agent-claw — set this when the new frontend repo
# adds a dev server. Leave empty during the CLI-only interim.
AGENT_CORS_ORIGINS=
```

c) Line 63 currently reads:
```
# Postgres tuning (agent-claw + frontend).
```
Change to:
```
# Postgres tuning (agent-claw).
```

d) Line 71 currently reads:
```
STREAMLIT_SERVER_PORT=8501
```
Delete this line entirely.

- [ ] **Step 11.2: Verify nothing else in `.env.example` mentions Streamlit or 8501**

```bash
grep -nE "streamlit|8501" .env.example
```

Expected: no output.

- [ ] **Step 11.3: Commit**

```bash
git add .env.example
git commit -m "chore(env): drop Streamlit / 8501 references from .env.example

CORS origins blanked — to be repopulated when the new frontend
repository wires up its dev server."
```

---

## Phase 3 — Documentation cleanup

### Task 12: README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 12.1: Replace the `make run.frontend` line**

Find line 57 (currently):
```
make run.frontend   # Streamlit on http://localhost:8501
```

Replace with:
```
chemclaw chat "ping"   # CLI wrapper around agent-claw /api/chat
```

- [ ] **Step 12.2: Add a short pointer to the CLI docs**

If there's a "Quick start" or "Local dev" section, add a single line:
```
For the CLI, see `tools/cli/README.md`.
```

If no obvious section exists, skip this sub-step.

- [ ] **Step 12.3: Sweep the rest of README.md for Streamlit / frontend mentions**

```bash
grep -niE "streamlit|frontend" README.md
```

Rewrite any remaining hits to refer to "the future frontend repository" or remove if obsolete.

- [ ] **Step 12.4: Commit**

```bash
git add README.md
git commit -m "docs(readme): replace make run.frontend with chemclaw chat"
```

---

### Task 13: CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

CLAUDE.md is the long-form codebase guide. Three surgical edits.

- [ ] **Step 13.1: "Running individual services" — drop the frontend line**

Around line 66, currently:
```
make run.frontend                # http://localhost:8501
```

Delete this line.

- [ ] **Step 13.2: RLS table — drop "frontend" from the `chemclaw_app` row**

Around line 109, currently:
```
| `chemclaw_app` | yes | NO | All app traffic (agent-claw, frontend, paperclip). Subject to FORCE RLS. |
```

Change "agent-claw, frontend, paperclip" to "agent-claw, paperclip".

- [ ] **Step 13.3: "Python Streamlit" example — replace with CLI**

Around line 117, currently:
```
- **Python Streamlit**: `connect(user_entra_id)` context manager in `services/frontend/db.py`.
```

Replace with:
```
- **Local CLI testing**: `chemclaw chat "..."` (see `tools/cli/README.md`). The CLI sends `x-user-entra-id` from `$CHEMCLAW_USER` and agent-claw applies it to the per-request RLS context.
```

- [ ] **Step 13.4: Verify no other Streamlit / frontend references remain in CLAUDE.md**

```bash
grep -niE "streamlit|frontend" CLAUDE.md
```

Expected: no output.

- [ ] **Step 13.5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): replace Streamlit references with CLI guidance"
```

---

### Task 14: AGENTS.md

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 14.1: SSE comment about chart fences**

Around line 204, currently:
```
The Streamlit frontend renders fenced chart blocks natively. Use them when a
```

Rewrite the surrounding paragraph so it reads (preserving meaning, removing the Streamlit-specific claim):

```
SSE-consuming clients (the future frontend; the CLI ignores chart fences)
can render fenced chart blocks. Continue to use them when a structured
chart helps the answer — the contract is preserved for downstream
renderers.
```

- [ ] **Step 14.2: SSE description in the manage_todos table**

Around line 89, the description says `Each write fires a todo_update SSE event so the frontend can render the live list.`

Change "the frontend" to "any SSE-consuming client (the future frontend; the CLI in --verbose mode)".

- [ ] **Step 14.3: Optimizer page reference**

Around line 709, currently:
```
Optimizer page (`services/frontend/pages/optimizer.py`).
```

Rewrite as:
```
Optimizer status is exposed via the agent-claw `/api/optimizer` route (the legacy Streamlit page at `services/frontend/pages/optimizer.py` was removed when the frontend moved to a separate repo).
```

- [ ] **Step 14.4: Sweep for any other "frontend" / "streamlit" hits**

```bash
grep -niE "streamlit|frontend" AGENTS.md
```

Rewrite remaining hits to reference the future frontend repo.

- [ ] **Step 14.5: Commit**

```bash
git add AGENTS.md
git commit -m "docs(agents.md): rewrite frontend/Streamlit refs as 'future frontend' / CLI"
```

---

### Task 15: docs/runbooks/local-dev.md

**Files:**
- Modify: `docs/runbooks/local-dev.md`

- [ ] **Step 15.1: Inspect the file**

```bash
grep -nE "streamlit|frontend|8501" docs/runbooks/local-dev.md
```

For each hit:
- If it's a section about running the Streamlit app, replace the section with a short "Local CLI" section pointing at `tools/cli/README.md`.
- If it's a stray mention, rewrite to refer to `chemclaw chat ...`.

- [ ] **Step 15.2: Commit**

```bash
git add docs/runbooks/local-dev.md
git commit -m "docs(runbook): swap Streamlit instructions for chemclaw CLI"
```

---

### Task 16: docs/adr/001-architecture.md

**Files:**
- Modify: `docs/adr/001-architecture.md`

- [ ] **Step 16.1: Inspect the file**

```bash
grep -nE "streamlit|frontend" docs/adr/001-architecture.md
```

- [ ] **Step 16.2: Append (or insert near the existing frontend mention) a short Status note**

```markdown
> **Status update (2026-04-27):** the in-tree Streamlit frontend has
> been removed. The frontend is being rebuilt in a separate repository
> and will consume the same `agent-claw` HTTP/SSE API documented above.
> See `docs/superpowers/specs/2026-04-27-remove-frontend-add-cli-design.md`.
```

- [ ] **Step 16.3: Commit**

```bash
git add docs/adr/001-architecture.md
git commit -m "docs(adr): note frontend removal + future separate-repo plan"
```

---

### Task 17: docs/plans/* — mark historical

**Files:**
- Modify: `docs/plans/clean-slate-audit.md`
- Modify: `docs/plans/post-v1.0.0-hardening-round-3.md`
- Modify: `docs/plans/mock-source-testbed.md`

These plans were written when the Streamlit frontend was still in-tree. They aren't deleted (history matters) but should carry a note.

- [ ] **Step 17.1: For each file, add a note at the very top (just under the H1)**

```markdown
> **Historical (2026-04-27):** references to the in-tree Streamlit frontend in this
> document are obsolete. The frontend has been removed and is being
> rebuilt in a separate repository. See
> `docs/superpowers/specs/2026-04-27-remove-frontend-add-cli-design.md`.
```

(Only insert if the file actually mentions the frontend; if not, skip
that file silently.)

- [ ] **Step 17.2: Commit**

```bash
git add docs/plans/
git commit -m "docs(plans): mark frontend-touching plans as historical"
```

---

## Phase 4 — Verification

### Task 18: Full lint / typecheck / test pass

- [ ] **Step 18.1: Lint**

```bash
make lint
```

Fix any ruff or eslint errors introduced by the changes.

- [ ] **Step 18.2: Typecheck**

```bash
make typecheck
```

Both Python (`mypy services` — the CLI lives under `tools/`, not `services/`, so it's not in the strict-mypy scope today) and TypeScript should be clean.

If you want the CLI under mypy's strict watch (recommended), edit `pyproject.toml` `[tool.mypy]` to add `tools/cli/chemclaw_cli` to the included sources, then fix any types. The CLI was written with full type hints, so it should pass `--strict` cleanly.

- [ ] **Step 18.3: Full test suite**

```bash
make test
```

Expected: pytest green (all existing + the 29 new CLI tests; minus the 5 deleted frontend test files), vitest green (unchanged — agent-claw tests stay at the prior count).

- [ ] **Step 18.4: Final repo grep — no surviving frontend code references**

```bash
grep -rn "services/frontend\|services\.frontend" --include="*.py" --include="*.ts" --include="*.yaml" --include="*.yml" --include="Makefile" --include="Dockerfile*" . | grep -v "^node_modules/\|^\.venv/\|^docs/" | head -20
```

Expected: empty.

```bash
grep -rin "streamlit" --include="*.py" --include="*.ts" --include="*.yaml" --include="*.yml" --include="Makefile" --include="Dockerfile*" . | grep -v "^node_modules/\|^\.venv/\|^docs/" | head -20
```

Expected: empty.

- [ ] **Step 18.5: Manual smoke (best-effort)**

Optional but recommended if Docker is available locally:

```bash
make up
make run.agent &
sleep 5
chemclaw chat "ping"
```

Expected: SSE-streamed response from the agent. Ctrl-C to stop the background agent.

If Docker isn't available, mark this step skipped — the unit tests cover the CLI's own behavior.

- [ ] **Step 18.6: Final commit (only if any verification step required fixes)**

```bash
git add -A
git commit -m "fix: address lint/typecheck issues uncovered during verification"
```

(If everything was already clean, skip this step.)

---

## Done criteria (matches the spec's acceptance criteria)

1. `services/frontend/` and `tests/unit/frontend/` no longer exist.
2. `tests/unit/test_forged_tools_page.py` no longer exists.
3. `infra/helm/values.yaml` has no `frontend:` block.
4. `grep -ri "streamlit" .` returns only `docs/` historical mentions.
5. `make setup` succeeds without Streamlit deps.
6. `make lint`, `make typecheck`, `make test` all green.
7. `chemclaw --version` prints `chemclaw 0.1.0`.
8. `chemclaw chat --help` prints typer-generated help.
9. With `make up` running, `chemclaw chat "ping"` returns a streamed
   response (manual smoke).
10. agent-claw test count unchanged (still 667 passed in vitest).
